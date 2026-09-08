/**
 * Decides whether an integrity read may be believed: at least two independent
 * RPC providers, reading the same block, have to return the same answer. Import
 * it from any check that grades a codehash, an owner set, a role holder or a
 * stored value.
 *
 * A single endpoint's word is not evidence. The deployer picks the endpoint list
 * — it comes out of a writable store — so one injected or lying provider must be
 * able to produce a refusal and nothing else. Every way that goal can fail is
 * enumerated on {@link TQuorumStatus}, and only one of those statuses is green.
 *
 * Pure: callers collect the observations, this grades them. It also never
 * receives an endpoint URL it is allowed to print — a premium endpoint carries
 * its API key in the URL — so everything rendered is a host-derived provider
 * identity or a redacted error.
 */

import { hostOf } from '../../mongoDb/rpcEndpoints'
import { sleep } from '../../utils/delay'
import { redactErrorReason } from '../../utils/redactUrls'

/**
 * Independent providers that must agree before a read is believed.
 *
 * Two: with one, a lying endpoint is the whole evidence base; with two, it can
 * only ever produce a disagreement, and a disagreement is a refusal.
 */
export const MIN_INDEPENDENT_PROVIDERS = 2

/** Bounded retry defaults for the transient statuses. */
export const DEFAULT_QUORUM_RETRY_POLICY: IQuorumRetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1_000, // 1 second
  maxDelayMs: 8_000, // 8 seconds
}

/**
 * How a quorum attempt ended. Stable strings: they are rendered to operators and
 * matched by callers, so treat a rename as a breaking change.
 *
 * `agreed` is the only green status. The rest all block, per T3 — an integrity
 * check that cannot reach quorum is an ERROR, and an ERROR blocks like a FAIL
 * with no acknowledgement path.
 *
 * - `agreed` — quorum reached on one value at one block.
 * - `agreed-absent` — quorum reached, and the value is empty. Separate because
 *   an integrity read of an address that is supposed to hold code treats `0x` as
 *   a failure, while a caller deliberately proving absence wants exactly this.
 * - `disagreement` — providers reading the same block returned different values.
 * - `fork-divergence` — same block number, different block hash: the providers
 *   are not on the same chain, so no comparison between them means anything.
 * - `heights-not-aligned` — the observations came from different block numbers,
 *   which makes a difference in value expected rather than evidence. The caller
 *   has to pin a block and re-read.
 * - `insufficient-providers` — fewer independent providers were consulted than
 *   the quorum needs. Never retried: another attempt cannot add an endpoint.
 * - `insufficient-responses` — enough providers were consulted, too few answered.
 * - `no-responses` — nothing answered.
 * - `quorum-misconfigured` — a caller asked for a quorum below
 *   {@link MIN_INDEPENDENT_PROVIDERS}, which would switch the control off.
 * - `provider-identity-unverifiable` — an endpoint names its host as a bare IP
 *   address, which cannot be shown independent of any hostname endpoint because
 *   a name may resolve to that very address. Never retried: another attempt
 *   cannot make the identity knowable.
 */
export type TQuorumStatus =
  | 'agreed'
  | 'agreed-absent'
  | 'disagreement'
  | 'fork-divergence'
  | 'heights-not-aligned'
  | 'insufficient-providers'
  | 'insufficient-responses'
  | 'no-responses'
  | 'provider-identity-unverifiable'
  | 'quorum-misconfigured'

/**
 * One provider's answer to the read.
 *
 * `blockNumber` and `blockHash` are mandatory on a successful observation: two
 * answers are only comparable when they describe the same block, so an
 * observation that cannot say which block it read is not evidence and is graded
 * as a non-response.
 */
export interface IProviderObservation {
  /** Endpoint the read went to. Never rendered — it can carry an API key. */
  endpointUrl: string
  /**
   * Operator-declared provider identity, when two hosts are known to share one
   * upstream. It can only ever merge two endpoints into one provider, never
   * split endpoints the URLs already say are the same one.
   */
  providerId?: string
  outcome: 'ok' | 'error'
  /** The value read, for `ok`. Compared case-insensitively after trimming. */
  value?: string
  blockNumber?: bigint
  blockHash?: string
  /** Provider-supplied failure text, for `error`. Redacted before rendering. */
  error?: string
}

/** What one provider contributed, as an operator reads it. */
export interface IProviderOutcomeSummary {
  /** Derived provider identity — a host fragment, never a URL. */
  provider: string
  /** Host the read went to, for telling two endpoints of one provider apart. */
  host: string
  counted: boolean
  /** Why it was not counted. Set exactly when `counted` is false. */
  rejection?: string
}

/** The verdict on one integrity read. */
export interface IRpcQuorumVerdict {
  status: TQuorumStatus
  /** True only for `agreed`. The single thing a caller may gate a green on. */
  reachesQuorum: boolean
  quorum: number
  /**
   * Independent providers that agreed on one value at one block, and zero
   * whenever no such agreement exists — a disagreement where a subset happened
   * to agree included. A caller proving a divergence needs a count it cannot
   * misread as consensus, so this is never a partial tally. It is not the same
   * question as {@link IRpcQuorumVerdict.reachesQuorum}: providers can agree
   * that there is nothing at an address, which is agreement and is also the
   * loudest integrity failure there is.
   */
  agreeingProviders: number
  /** Largest agreeing provider group, for the operator. Never a gate. */
  largestAgreeingGroup: number
  /** Independent providers that answered at all. */
  respondingProviders: number
  /** Independent providers consulted, answering or not. */
  independentProviders: number
  endpointsConsulted: number
  /** The agreed value, on `agreed` and `agreed-absent` only. */
  agreedValue?: string
  blockNumber?: bigint
  blockHash?: string
  /** Whether a bounded retry could plausibly change this verdict. */
  transient: boolean
  /** One line an operator can act on. */
  detail: string
  perProvider: IProviderOutcomeSummary[]
}

/** Bounded-retry shape for the transient statuses. */
export interface IQuorumRetryPolicy {
  maxAttempts: number
  initialDelayMs: number
  maxDelayMs: number
}

/** Whether to make another attempt, and how long to wait first. */
export interface IQuorumRetryPlan {
  retry: boolean
  delayMs: number
  reason: string
}

/** A resolved read: the final verdict plus what the retry loop did. */
export interface IRpcQuorumResolution {
  verdict: IRpcQuorumVerdict
  attempts: number
  /** Waits taken between attempts, in order. */
  delaysMs: number[]
}

/** Quorum reachability for one network's configured endpoints. */
export interface INetworkQuorumCoverage {
  network: string
  endpoints: number
  independentProviders: number
  /** Derived provider identities, sorted. */
  providers: string[]
  reachesQuorum: boolean
}

/** Fleet-wide quorum reachability. */
export interface IQuorumCoverageReport {
  quorum: number
  /**
   * Where the endpoint lists came from, carried into the rendered line.
   *
   * Required, because a bare coverage number gets quoted as a fleet fact. A
   * source that holds one endpoint per network can only ever report none
   * reaching a quorum above one, however many the fleet really has, so the
   * figure means nothing without the thing it counted.
   */
  source: string
  networks: INetworkQuorumCoverage[]
  /** Networks that cannot reach quorum, sorted by name. */
  below: INetworkQuorumCoverage[]
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/** Empty answers: no code, and the zero word an absent storage slot reads as. */
const EMPTY_VALUE = /^(0x)?0*$/

/**
 * Identity every bare-IP endpoint collapses onto.
 *
 * An address cannot be shown independent of a name that might resolve to it, so
 * counting one as a provider of its own is the single direction that can invent
 * a quorum. Sharing one identity also stops several addresses inflating the
 * count between themselves.
 */
export const IP_LITERAL_IDENTITY = '<ip-literal host>'

/**
 * Provider identity for an endpoint URL: the host's last two labels, lowercased
 * and without its port.
 *
 * Deliberately over-collapsing. Every error this makes merges two providers into
 * one, which can only lower the counted independence and so can only turn a
 * green into a refusal; the opposite error — splitting one provider into two —
 * is what manufactures a false quorum. Two hosts that share an upstream without
 * sharing a domain are invisible to this and stay a named residual; an operator
 * closes those with {@link IProviderObservation.providerId}.
 *
 * @param url - endpoint URL, never rendered by this module
 * @returns A host-derived identity, or one of two shared sentinels: every
 *   bare-IP host collapses onto one, and every URL that will not parse onto
 *   another, so neither can be counted as a provider of its own
 */
export const providerIdentityForUrl = (url: string): string => {
  const host = hostOf(url).toLowerCase()
  if (host === '<unparsable url>') return host

  // An IPv6 host arrives bracketed and its colons are not label separators.
  const bare = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.replace(/:\d+$/, '')
  if (bare.startsWith('[') || IPV4.test(bare)) return IP_LITERAL_IDENTITY

  const labels = bare.split('.').filter(Boolean)
  if (labels.length < 2) return bare

  return labels.slice(-2).join('.')
}

/**
 * Group endpoints into independent providers.
 *
 * Two endpoints are one provider when their URLs derive the same identity **or**
 * when they carry the same declared `providerId`, so a declaration can only
 * merge endpoints — it can never split two the URLs already call the same
 * provider. That asymmetry is the point: a merge lowers the count, a split would
 * raise it, and only one of those directions can invent a quorum.
 *
 * @param observations - the endpoints consulted, answering or not
 * @returns One canonical identity per input observation, in input order
 */
export const groupProviders = (
  observations: readonly IProviderObservation[]
): string[] => {
  const parent = observations.map((_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root] as number
    return root
  }
  const union = (a: number, b: number): void => {
    const [rootA, rootB] = [find(a), find(b)]
    if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB)
  }

  const byDerived = new Map<string, number>()
  const byDeclared = new Map<string, number>()
  const derived = observations.map((observation) =>
    providerIdentityForUrl(observation.endpointUrl)
  )

  observations.forEach((observation, index) => {
    const derivedKey = derived[index] as string
    const firstDerived = byDerived.get(derivedKey)
    if (firstDerived === undefined) byDerived.set(derivedKey, index)
    else union(firstDerived, index)

    if (!observation.providerId) return
    const firstDeclared = byDeclared.get(observation.providerId)
    if (firstDeclared === undefined)
      byDeclared.set(observation.providerId, index)
    else union(firstDeclared, index)
  })

  return observations.map((_, index) => derived[find(index)] as string)
}

const normalizeValue = (value: string): string => value.trim().toLowerCase()

const describeRejection = (
  observation: IProviderObservation
): string | undefined => {
  if (observation.outcome === 'error')
    return `read failed: ${redactErrorReason(
      observation.error ?? 'no error reported'
    )}`

  if (typeof observation.value !== 'string')
    return 'reported success without a value'

  if (observation.blockNumber === undefined || !observation.blockHash)
    return 'reported success without a block reference, so it cannot be compared'

  return undefined
}

interface IUsableObservation {
  provider: string
  value: string
  blockNumber: bigint
  blockHash: string
}

const countProviders = (
  usable: readonly IUsableObservation[],
  predicate: (observation: IUsableObservation) => boolean = () => true
): number => new Set(usable.filter(predicate).map((o) => o.provider)).size

/**
 * Grade one integrity read across the providers that were consulted.
 *
 * The order of the checks is the safety property. Block alignment is settled
 * before values are compared, because observations from different heights are
 * *expected* to differ and calling that a disagreement would report an attack
 * where there is lag. Provider shortfall is settled after divergence, so a
 * thinly-configured chain still surfaces a real disagreement, and before any
 * counting of agreement, so a chain with one provider can never read as
 * consensus. An identity that cannot be established is the exception, settled
 * ahead of divergence: every later verdict reads a provider count, and an
 * unknowable identity makes that count unsound rather than merely thin — so a
 * fork or a disagreement reported alongside it would rest on a denominator
 * this module cannot vouch for. The green branch is last and requires every
 * condition affirmatively, so an unforeseen combination refuses.
 *
 * @param observations - one entry per endpoint consulted, in any order
 * @param quorum - independent providers that must agree; defaults to
 *   {@link MIN_INDEPENDENT_PROVIDERS} and is refused below it
 * @returns The verdict, green only when the quorum genuinely agreed
 */
export const evaluateRpcQuorum = (
  observations: readonly IProviderObservation[],
  quorum: number = MIN_INDEPENDENT_PROVIDERS
): IRpcQuorumVerdict => {
  const providers = groupProviders(observations)
  const perProvider: IProviderOutcomeSummary[] = observations.map(
    (observation, index) => {
      const rejection = describeRejection(observation)
      return {
        provider: providers[index] as string,
        host: hostOf(observation.endpointUrl),
        counted: rejection === undefined,
        ...(rejection === undefined ? {} : { rejection }),
      }
    }
  )

  const usable: IUsableObservation[] = observations.flatMap(
    (observation, index) =>
      perProvider[index]?.counted
        ? [
            {
              provider: providers[index] as string,
              value: normalizeValue(observation.value as string),
              blockNumber: observation.blockNumber as bigint,
              blockHash: normalizeValue(observation.blockHash as string),
            },
          ]
        : []
  )

  const independentProviders = new Set(providers).size
  const respondingProviders = countProviders(usable)
  const base = {
    quorum,
    agreeingProviders: 0,
    largestAgreeingGroup: 0,
    respondingProviders,
    independentProviders,
    endpointsConsulted: observations.length,
    perProvider,
  }

  if (quorum < MIN_INDEPENDENT_PROVIDERS)
    return {
      ...base,
      status: 'quorum-misconfigured',
      reachesQuorum: false,
      transient: false,
      detail: `a quorum of ${quorum} is below the minimum of ${MIN_INDEPENDENT_PROVIDERS}: at that setting a single lying endpoint is the whole evidence base, so the read is refused rather than run`,
    }

  // Ahead of every other verdict, because each of them reads a provider count
  // that an unknowable identity makes unsound: a name may resolve to the
  // address, so an IP endpoint alongside a hostname one cannot be shown to be a
  // second provider.
  if (providers.includes(IP_LITERAL_IDENTITY))
    return {
      ...base,
      status: 'provider-identity-unverifiable',
      reachesQuorum: false,
      transient: false,
      detail: `an endpoint names its host as a bare IP address, which cannot be shown independent of a hostname endpoint that may resolve to it: give every endpoint a hostname, or declare a providerId so the endpoints are counted as one`,
    }

  if (usable.length === 0)
    return {
      ...base,
      status:
        independentProviders < quorum
          ? 'insufficient-providers'
          : 'no-responses',
      reachesQuorum: false,
      // A shortfall of endpoints is a configuration fact; a shortfall of
      // answers from enough endpoints is an outage.
      transient: independentProviders >= quorum,
      detail:
        independentProviders < quorum
          ? `only ${independentProviders} independent provider(s) were consulted, below the quorum of ${quorum}: nothing about this read has been verified`
          : `all ${independentProviders} independent provider(s) failed to answer: the read is unverified, not verified-as-unchanged`,
    }

  const heights = new Set(usable.map((o) => o.blockNumber))
  if (heights.size > 1)
    return {
      ...base,
      status: 'heights-not-aligned',
      reachesQuorum: false,
      transient: true,
      detail: `providers answered at ${
        heights.size
      } different block heights (${[...heights]
        .sort((a, b) => (a < b ? -1 : 1))
        .join(
          ', '
        )}): values from different blocks are not comparable, so pin a block and re-read`,
    }

  const hashes = new Set(usable.map((o) => o.blockHash))
  if (hashes.size > 1)
    return {
      ...base,
      status: 'fork-divergence',
      reachesQuorum: false,
      transient: false,
      detail: `providers report ${hashes.size} different block hashes at block ${usable[0]?.blockNumber}: they are not on the same chain, so no comparison between them carries evidence`,
    }

  const values = new Set(usable.map((o) => o.value))
  const largestAgreeingGroup = Math.max(
    ...[...values].map((value) =>
      countProviders(usable, (o) => o.value === value)
    )
  )

  if (values.size > 1)
    return {
      ...base,
      largestAgreeingGroup,
      status: 'disagreement',
      reachesQuorum: false,
      // A majority is not a quorum: a provider that lies about one value is not
      // evidence about the others, so no subset of a divergent read is believed.
      transient: false,
      detail: `providers returned ${values.size} different values at block ${usable[0]?.blockNumber} (largest agreeing group: ${largestAgreeingGroup} provider(s) of ${respondingProviders} that answered): one of them is wrong and this read cannot say which`,
    }

  if (independentProviders < quorum)
    return {
      ...base,
      largestAgreeingGroup,
      status: 'insufficient-providers',
      reachesQuorum: false,
      transient: false,
      detail: `${independentProviders} independent provider(s) were consulted, below the quorum of ${quorum}: an unopposed answer is not an agreed one`,
    }

  if (largestAgreeingGroup < quorum)
    return {
      ...base,
      largestAgreeingGroup,
      status: 'insufficient-responses',
      reachesQuorum: false,
      transient: true,
      detail: `${largestAgreeingGroup} of ${independentProviders} independent provider(s) answered, below the quorum of ${quorum}: providers that were never asked or that failed do not count toward agreement`,
    }

  const agreed = usable[0] as IUsableObservation
  const absent = EMPTY_VALUE.test(agreed.value)

  return {
    ...base,
    largestAgreeingGroup,
    agreeingProviders: largestAgreeingGroup,
    status: absent ? 'agreed-absent' : 'agreed',
    reachesQuorum: !absent,
    transient: false,
    agreedValue: agreed.value,
    blockNumber: agreed.blockNumber,
    blockHash: agreed.blockHash,
    detail: absent
      ? `${largestAgreeingGroup} independent providers agree there is nothing at this location at block ${agreed.blockNumber}: an integrity read of something that should exist treats that as a failure, not a pass`
      : `${largestAgreeingGroup} independent providers agree at block ${agreed.blockNumber}`,
  }
}

/**
 * Whether to attempt the read again, and how long to wait first.
 *
 * Only the transient statuses are retried, and a disagreement is never one of
 * them: retrying a divergence until it goes away is how a lying provider gets a
 * second chance. Backoff doubles from the policy's initial delay and is capped.
 *
 * @param verdict - the verdict from the attempt just made
 * @param attempt - 1-based number of attempts made so far
 * @param policy - bounded-retry shape; defaults to
 *   {@link DEFAULT_QUORUM_RETRY_POLICY}
 * @returns Whether to retry, the wait before doing so, and why
 */
export const planQuorumRetry = (
  verdict: IRpcQuorumVerdict,
  attempt: number,
  policy: IQuorumRetryPolicy = DEFAULT_QUORUM_RETRY_POLICY
): IQuorumRetryPlan => {
  if (!verdict.transient)
    return {
      retry: false,
      delayMs: 0,
      reason: `${verdict.status} does not improve with another attempt`,
    }

  if (attempt >= policy.maxAttempts)
    return {
      retry: false,
      delayMs: 0,
      reason: `${verdict.status} persisted across ${attempt} attempt(s), the bounded maximum`,
    }

  return {
    retry: true,
    delayMs: Math.min(
      policy.initialDelayMs * 2 ** (attempt - 1),
      policy.maxDelayMs
    ),
    reason: `${verdict.status} may be transient: attempt ${attempt + 1} of ${
      policy.maxAttempts
    }`,
  }
}

/**
 * Run one integrity read to a verdict, retrying only transient failures.
 *
 * @param collect - performs the read against every endpoint; receives the
 *   1-based attempt number and returns one observation per endpoint
 * @param options.quorum - independent providers that must agree
 * @param options.policy - bounded-retry shape
 * @param options.sleep - injected wait, so tests take no wall-clock time;
 *   defaults to a real sleep, because an unwaited backoff is not one
 * @returns The final verdict and what the loop did to reach it
 */
export const resolveRpcQuorum = async (
  collect: (attempt: number) => Promise<readonly IProviderObservation[]>,
  options: {
    quorum?: number
    policy?: IQuorumRetryPolicy
    sleep?: (ms: number) => Promise<void>
  } = {}
): Promise<IRpcQuorumResolution> => {
  const policy = options.policy ?? DEFAULT_QUORUM_RETRY_POLICY
  const wait = options.sleep ?? sleep
  const delaysMs: number[] = []
  let attempt = 0
  let verdict: IRpcQuorumVerdict

  for (;;) {
    attempt += 1
    verdict = evaluateRpcQuorum(await collect(attempt), options.quorum)
    const plan = planQuorumRetry(verdict, attempt, policy)
    if (!plan.retry) break

    delaysMs.push(plan.delayMs)
    await wait(plan.delayMs)
  }

  return { verdict, attempts: attempt, delaysMs }
}

const RED = `${String.fromCharCode(27)}[31m`
const GREEN = `${String.fromCharCode(27)}[32m`
const RESET = `${String.fromCharCode(27)}[0m`

/**
 * The lines an operator sees for one read.
 *
 * A green verdict prints too: a check that is silent when it passes teaches the
 * operator that silence means verified, which is exactly what an unreached
 * quorum also looks like.
 *
 * @param verdict - what `evaluateRpcQuorum` decided
 * @param label - what was read, e.g. `codehash of 0xabc… on mainnet`
 * @returns Display lines: the verdict, then one line per provider consulted
 */
export const renderRpcQuorum = (
  verdict: IRpcQuorumVerdict,
  label: string
): string[] => {
  const head = verdict.reachesQuorum
    ? `${GREEN}✓ QUORUM ${label}: ${verdict.detail}${RESET}`
    : `${RED}⛔ NO QUORUM ${label} [${verdict.status}]: ${verdict.detail}${RESET}`

  const rows = verdict.perProvider.map(
    (entry) =>
      `  ${entry.provider} (${entry.host}) → ${
        entry.counted ? 'counted' : `not counted — ${entry.rejection}`
      }`
  )

  return [
    head,
    `  agreeing independent providers: ${verdict.agreeingProviders} of ${verdict.quorum} required · ${verdict.respondingProviders} answered · ${verdict.independentProviders} consulted across ${verdict.endpointsConsulted} endpoint(s)`,
    ...rows,
  ]
}

/**
 * Throws unless the read reached quorum.
 *
 * Every non-green status throws, transient ones included: T3 makes an
 * infrastructure ERROR block exactly like a FAIL, so there is no argument shape
 * here in which an unverified read continues.
 *
 * @param verdict - what `evaluateRpcQuorum` decided
 * @param label - what was read, named in the refusal
 * @throws When the read did not reach quorum
 */
export const assertRpcQuorum = (
  verdict: IRpcQuorumVerdict,
  label: string
): void => {
  if (verdict.reachesQuorum) return

  throw new Error(
    `RPC quorum: refusing to believe ${label}. [${verdict.status}] ${verdict.detail}. Nothing has been verified and nothing may proceed on this read.`
  )
}

/**
 * Which networks can reach quorum at all, from their configured endpoints.
 *
 * A chain whose endpoints all resolve to one provider cannot produce a green
 * integrity read, and that is a fact about configuration rather than about any
 * one read — so it is reported ahead of time instead of surfacing as a refusal
 * during a signing session.
 *
 * @param endpointsByNetwork - endpoint URLs per network key
 * @param quorum - independent providers required; defaults to
 *   {@link MIN_INDEPENDENT_PROVIDERS}
 * @returns Every network's provider count, plus those below the quorum
 */
export const evaluateQuorumCoverage = (
  endpointsByNetwork: Record<string, readonly string[]>,
  source: string,
  quorum: number = MIN_INDEPENDENT_PROVIDERS
): IQuorumCoverageReport => {
  const networks = Object.keys(endpointsByNetwork)
    .sort()
    .map((network) => {
      const urls = endpointsByNetwork[network] ?? []
      const providers = [
        ...new Set(
          groupProviders(
            urls.map((endpointUrl) => ({
              endpointUrl,
              outcome: 'ok' as const,
            }))
          )
        ),
      ].sort()

      return {
        network,
        endpoints: urls.length,
        independentProviders: providers.length,
        providers,
        reachesQuorum: providers.length >= quorum,
      }
    })

  return {
    quorum,
    source,
    networks,
    below: networks.filter((entry) => !entry.reachesQuorum),
  }
}

/**
 * The coverage report an operator reads.
 *
 * Names every network that cannot reach quorum rather than summarising them,
 * because the count alone is what lets a chain sit uncovered for months.
 *
 * @param report - what `evaluateQuorumCoverage` produced
 * @returns Display lines: the rollup, then one line per uncovered network
 */
export const renderQuorumCoverage = (
  report: IQuorumCoverageReport
): string[] => {
  const covered = report.networks.length - report.below.length
  const head = `RPC quorum coverage in ${report.source}: ${covered}/${report.networks.length} network(s) reach ${report.quorum} independent providers`

  if (report.below.length === 0) return [`${GREEN}✓ ${head}${RESET}`]

  return [
    `${RED}⛔ ${head} — ${report.below.length} cannot${RESET}`,
    ...report.below.map(
      (entry) =>
        `  ${entry.network}: ${
          entry.independentProviders
        } independent provider(s) across ${entry.endpoints} endpoint(s) [${
          entry.providers.join(', ') || 'none'
        }]`
    ),
  ]
}
