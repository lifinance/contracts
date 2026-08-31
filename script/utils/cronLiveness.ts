/**
 * Pure decision layer for the cron-liveness watchdog.
 *
 * Splitting the logic from the runner keeps every rule here testable without a
 * GitHub token, a network or a clock: the runner supplies facts (last run time,
 * workflow state, "now") and this module returns verdicts.
 */

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** Slack on top of the nominal interval, absorbing GitHub's scheduler drift. */
const GRACE_INTERVAL_MULTIPLIER = 1.5
const GRACE_FIXED_SLACK_MS = 3 * HOUR_MS

export interface ICronCadence {
  kind: 'minutely' | 'hourly' | 'daily' | 'weekly' | 'monthly'
  intervalMs: number
}

export interface IUnclassifiableCron {
  kind: 'unclassifiable'
  reason: string
}

export type TCronClassification = ICronCadence | IUnclassifiableCron

const isPlainInteger = (field: string): boolean => /^\d+$/.test(field)

const parseStep = (field: string): number | null => {
  const match = /^\*\/(\d+)$/.exec(field)
  if (!match?.[1]) return null

  const step = Number(match[1])
  return step > 0 ? step : null
}

/**
 * Bucket a 5-field cron expression into a cadence.
 *
 * Deliberately coarse: the watchdog asks "is this obviously stale", not "is this
 * three minutes late", so a bucket plus a generous grace window is enough and a
 * full cron parser (and its dependency) is not. The one hard requirement is that
 * anything outside the modelled shapes returns `unclassifiable` rather than a
 * guess — a wrong guess under-alerts silently, which is the failure mode this
 * whole watchdog exists to remove.
 */
export function classifyCron(expression: string): TCronClassification {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5)
    return {
      kind: 'unclassifiable',
      reason: `expected 5 cron fields, got ${fields.length}`,
    }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string
  ]

  // Steps are only modelled on the minute field; anywhere else the real period is
  // not one of our buckets, so bucketing it would understate how often it runs.
  for (const [name, field] of [
    ['hour', hour],
    ['day-of-month', dayOfMonth],
    ['month', month],
    ['day-of-week', dayOfWeek],
  ] as const)
    if (field.includes('/'))
      return {
        kind: 'unclassifiable',
        reason: `step syntax in the ${name} field is not modelled: '${field}'`,
      }

  for (const [name, field] of [
    ['minute', minute],
    ['hour', hour],
    ['day-of-month', dayOfMonth],
    ['month', month],
    ['day-of-week', dayOfWeek],
  ] as const)
    if (field !== '*' && !isPlainInteger(field) && parseStep(field) === null)
      return {
        kind: 'unclassifiable',
        reason: `unsupported ${name} field: '${field}'`,
      }

  // A fixed month fires once a YEAR. Bucketing it as monthly would hand it a ~47d
  // grace window and alert every year for the other eleven months.
  if (isPlainInteger(month))
    return {
      kind: 'unclassifiable',
      reason: `a fixed month ('${month}') fires yearly, which is outside the modelled buckets`,
    }

  // Day-of-week is checked FIRST: cron ORs dom and dow when both are restricted, so
  // '0 9 1 * 3' fires on the 1st and every Wednesday. Taking the monthly bucket there
  // would grant ~46.6d of grace for a schedule that runs weekly, and under-alert.
  if (isPlainInteger(dayOfWeek))
    return { kind: 'weekly', intervalMs: 7 * DAY_MS }

  if (isPlainInteger(dayOfMonth))
    return { kind: 'monthly', intervalMs: 31 * DAY_MS }

  if (isPlainInteger(hour)) return { kind: 'daily', intervalMs: DAY_MS }

  const minuteStep = parseStep(minute)
  if (minuteStep !== null)
    return { kind: 'minutely', intervalMs: minuteStep * MINUTE_MS }

  if (isPlainInteger(minute)) return { kind: 'hourly', intervalMs: HOUR_MS }

  return {
    kind: 'unclassifiable',
    reason: `no cadence bucket matches '${expression}'`,
  }
}

/**
 * How long a workflow may stay silent before it counts as stale.
 *
 * A single late run must never alert — GitHub's scheduler routinely drifts hours
 * under load — but two missed cycles must.
 */
export function graceWindowMs(cadence: ICronCadence): number {
  return cadence.intervalMs * GRACE_INTERVAL_MULTIPLIER + GRACE_FIXED_SLACK_MS
}

/** Every cron expression declared in a workflow's `on.schedule` block. */
export function extractCronExpressions(workflowYaml: string): string[] {
  const expressions: string[] = []

  for (const line of workflowYaml.split('\n')) {
    if (/^\s*#/.test(line)) continue

    const match = /^\s*-\s*cron:\s*(.+)$/.exec(line)
    if (!match?.[1]) continue

    expressions.push(stripYamlScalar(match[1]))
  }

  return expressions
}

/** Unwrap a quoted scalar, or drop a trailing `#` comment from a bare one. */
function stripYamlScalar(rawValue: string): string {
  const value = rawValue.trim()

  const quoted = /^(['"])(.*?)\1/.exec(value)
  if (quoted?.[2] !== undefined) return quoted[2].trim()

  const commentAt = value.indexOf('#')
  return (commentAt === -1 ? value : value.slice(0, commentAt)).trim()
}

export interface IIgnoreMarker {
  ignored: boolean
  reason?: string
}

/**
 * Opt-out marker: `# watchdog:ignore <reason>` in the workflow's own YAML.
 *
 * The reason is mandatory — an unexplained exclusion is indistinguishable from an
 * accident, and it has to be visible in review next to the cron it excuses.
 */
export function findIgnoreMarker(workflowYaml: string): IIgnoreMarker {
  const match = /^[ \t]*#[ \t]*watchdog:ignore[ \t]+([^\n]+)$/m.exec(
    workflowYaml
  )
  if (!match?.[1]) return { ignored: false }

  return { ignored: true, reason: match[1].trim() }
}

export type TLivenessStatus =
  | 'alive'
  | 'stale'
  | 'disabled'
  | 'ignored'
  | 'unclassifiable'
  | 'pending-first-run'
  | 'lookup-failed'

export interface IWorkflowFacts {
  name: string
  path: string
  /** GitHub's `workflow.state`: `active`, `disabled_manually`, `disabled_inactivity`. */
  state: string
  cronExpressions: string[]
  ignore: IIgnoreMarker
  /**
   * When this workflow last ran *on its schedule*. A `workflow_dispatch` run must
   * never count here: a manual kick is not evidence the cron still fires, and
   * treating it as such is precisely how a dead schedule stays hidden.
   */
  lastScheduledRunAt: Date | null
  /** First commit touching the workflow file; bounds how long it has had to fire. */
  fileFirstSeenAt: Date | null
  /**
   * The run lookup itself failed (GitHub API error), so `lastScheduledRunAt` being
   * null carries no information. Without this flag a transient API hiccup reads as
   * a dead cron and pages someone for GitHub's downtime.
   */
  runLookupFailed: boolean
}

export interface ILivenessVerdict {
  name: string
  path: string
  status: TLivenessStatus
  detail: string
}

/** Statuses that warrant a Slack alert; the rest are summary-only. */
export function isAlertable(status: TLivenessStatus): boolean {
  return (
    status === 'stale' ||
    status === 'disabled' ||
    status === 'unclassifiable' ||
    status === 'lookup-failed'
  )
}

const formatAge = (ms: number): string => {
  const hours = ms / HOUR_MS
  return hours < 48 ? `${hours.toFixed(1)}h` : `${(ms / DAY_MS).toFixed(1)}d`
}

/**
 * Decide whether one scheduled workflow is still alive.
 *
 * Checks are ordered by how actionable their answer is, not by how cheap they
 * are: a disabled workflow is also stale, but only "disabled" says what to do.
 */
export function evaluateLiveness(
  facts: IWorkflowFacts,
  now: Date
): ILivenessVerdict {
  const base = { name: facts.name, path: facts.path }

  if (facts.ignore.ignored)
    return {
      ...base,
      status: 'ignored',
      detail: `opted out: ${facts.ignore.reason ?? 'no reason given'}`,
    }

  if (facts.state !== 'active')
    return {
      ...base,
      status: 'disabled',
      detail: `workflow state is '${facts.state}' — it will not fire until re-enabled`,
    }

  if (facts.cronExpressions.length === 0)
    return {
      ...base,
      status: 'unclassifiable',
      detail: 'no cron expression found in on.schedule',
    }

  // Any expression we cannot bucket makes the whole workflow unwatchable: the
  // alternative is checking it against its other crons and quietly ignoring the
  // one we failed to read, which under-covers exactly where we understand least.
  const classifications = facts.cronExpressions.map((expression) => ({
    expression,
    classification: classifyCron(expression),
  }))

  const unreadable = classifications.filter(
    (entry) => entry.classification.kind === 'unclassifiable'
  )
  if (unreadable.length > 0) {
    const reasons = unreadable
      .map(
        (entry) =>
          `'${entry.expression}' (${
            (entry.classification as IUnclassifiableCron).reason
          })`
      )
      .join('; ')
    return {
      ...base,
      status: 'unclassifiable',
      detail: `needs a classifier rule: ${reasons}`,
    }
  }

  // Ordered after classification so a bad cron is still reported, but before any use
  // of lastScheduledRunAt — which is null on a failed lookup and would otherwise be
  // indistinguishable from "never ran".
  if (facts.runLookupFailed)
    return {
      ...base,
      status: 'lookup-failed',
      detail: 'scheduled runs could not be read from the GitHub API',
    }

  // The most frequent schedule governs: a workflow that also runs weekly is still
  // dead if its hourly run stopped.
  const cadences = classifications.map(
    (entry) => entry.classification as ICronCadence
  )
  const tightest = cadences.reduce((shortest, cadence) =>
    cadence.intervalMs < shortest.intervalMs ? cadence : shortest
  )
  const grace = graceWindowMs(tightest)

  if (facts.lastScheduledRunAt === null) {
    const mergedAgo =
      facts.fileFirstSeenAt === null
        ? null
        : now.getTime() - facts.fileFirstSeenAt.getTime()

    if (mergedAgo !== null && mergedAgo <= grace)
      return {
        ...base,
        status: 'pending-first-run',
        detail: `merged ${formatAge(mergedAgo)} ago, first ${
          tightest.kind
        } run not due yet`,
      }

    return {
      ...base,
      status: 'stale',
      detail:
        mergedAgo === null
          ? 'has never run on its schedule (file date unknown — shallow checkout?)'
          : `has never run on its schedule, ${formatAge(
              mergedAgo
            )} after being merged`,
    }
  }

  const silentFor = now.getTime() - facts.lastScheduledRunAt.getTime()
  if (silentFor > grace)
    return {
      ...base,
      status: 'stale',
      detail: `last ${tightest.kind} run was ${formatAge(
        silentFor
      )} ago (grace ${formatAge(grace)})`,
    }

  return {
    ...base,
    status: 'alive',
    detail: `last ${tightest.kind} run ${formatAge(silentFor)} ago`,
  }
}

export interface ISlackMessageOptions {
  /** Post a green summary even when nothing is wrong (the weekly heartbeat). */
  heartbeat: boolean
  runUrl: string
}

const STATUS_HEADINGS: Record<string, string> = {
  stale: 'Stale (no scheduled run inside the grace window)',
  disabled: 'Disabled (will not fire until re-enabled)',
  unclassifiable: 'Unwatchable (needs a classifier rule)',
  'lookup-failed': 'Undetermined (GitHub API lookup failed)',
}

/**
 * Render the Slack post, or `null` to stay silent.
 *
 * Silence is the normal outcome: the channel carries problems, not routine
 * confirmations. The weekly heartbeat is the deliberate exception — without one,
 * a dead watchdog looks exactly like a healthy fleet, which is the blind spot
 * this whole job exists to close.
 */
export function composeSlackMessage(
  verdicts: ILivenessVerdict[],
  options: ISlackMessageOptions
): string | null {
  const alertable = verdicts.filter((verdict) => isAlertable(verdict.status))

  if (alertable.length === 0 && !options.heartbeat) return null

  const link = `<${options.runUrl}|View workflow run>`

  if (alertable.length === 0) {
    const ignored = verdicts.filter((verdict) => verdict.status === 'ignored')
    const watched = verdicts.length - ignored.length
    const optOutNote =
      ignored.length > 0 ? ` (${ignored.length} opted out)` : ''

    return [
      `:white_check_mark: *Cron liveness — ${watched}/${watched} scheduled workflows alive*${optOutNote}`,
      link,
    ].join('\n')
  }

  const sections = Object.entries(STATUS_HEADINGS)
    .map(([status, heading]) => {
      const matching = alertable.filter((verdict) => verdict.status === status)
      if (matching.length === 0) return null

      const lines = matching.map(
        (verdict) => `  • *${verdict.name}* — ${verdict.detail}`
      )
      return [`*${heading}*`, ...lines].join('\n')
    })
    .filter((section): section is string => section !== null)

  return [
    `:rotating_light: *Cron liveness — ACTION NEEDED* (${alertable.length} of ${verdicts.length} scheduled workflows)`,
    ...sections,
    link,
  ].join('\n')
}
