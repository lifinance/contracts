/**
 * Renders the signing-ask card for a set of Safe proposals.
 *
 * Pure: rows in, text out. The Mongo read and the file write live in
 * `render-proposal-card.ts`.
 */

import {
  MAX_DIRTY_PATHS,
  sanitizeProvenanceText,
} from '../shared/git-provenance'

import { MAX_PROPOSAL_REASON_LENGTH } from './proposal-intent'

/** How many networks are named individually before the card switches to a count. */
const NAMED_NETWORK_LIMIT = 4

/** Enough of a hash to match a card to a proposal by eye. */
const SHORT_HASH_CHARS = 10

/** Commit prefix long enough to be unambiguous in this repo. */
const SHORT_COMMIT_CHARS = 12

/**
 * Cap for every field except `reason`, `gitCommit` and `safeTxHash`, which have
 * their own tighter caps.
 *
 * The card's own cap is not enough alone: a single oversized `contract`,
 * `prUrl`, `proposerHandle`, `checkSummary` or network name can consume the
 * whole budget and push the review command — the one line that makes the card
 * actionable — off the bottom.
 */
const MAX_FIELD_CHARS = 200

/**
 * One proposal, flattened from its document and provenance block.
 *
 * Every field but `network` is `unknown`: a row stored before provenance
 * capture, or hand-edited since, can hold a number or `null` anywhere, and a
 * throw here silently downgrades the whole card to the count-only fallback.
 * `escape` coerces, so the renderer is total over any document shape.
 */
export interface ICardProposal {
  network: string
  safeTxHash?: unknown
  proposerHandle?: unknown
  actor?: unknown
  reason?: unknown
  prUrl?: unknown
  gitCommit?: unknown
  dirtyTreeScoped?: unknown
  /** Capture sets this when it stopped counting; the list is then a floor. */
  dirtyTreeTruncated?: unknown
  /** Capture records why it could not measure; a non-empty list is not clean. */
  captureErrors?: unknown
  /**
   * Result of a check the PROPOSER ran. Rendered as advisory: the authoritative
   * status is the signer-side attestation, and a card that states a result
   * without saying so invites signing on the card's word.
   */
  checkSummary?: unknown
}

/** One row of the per-network expected-hash table. */
export interface IExpectedHashRow {
  network: string
  expected: string
  actual?: string
}

export interface ICardOptions {
  /** Rendered only when supplied. */
  expectedHashes?: IExpectedHashRow[]
  /**
   * How many proposals the run actually created. Compared against the rows
   * found, because a card reading fewer than that leaves proposals nobody is
   * told to sign — the one error here with a direct safety consequence.
   */
  expectedCount?: number
  /** The contract the run touched; the message this replaces named it. */
  contract?: string
}

/**
 * Cap for the whole card.
 *
 * Nothing downstream truncates — `send-slack-webhook-message.ts` posts the text
 * verbatim and `SlackNotifier` only caps the `blocks[].text` fields it builds
 * itself — so an over-long card would reach Slack whole and lose its bottom to
 * the client's own collapsing. Cutting here keeps the loss visible.
 *
 * Not 3000: that is the per-`blocks[].text` limit (see `slack-notifier.ts`),
 * and this card posts as a top-level `text`, whose limit is 40,000. Held well
 * below 40,000 anyway, because a card nobody scrolls to the end of has already
 * failed.
 */
export const SLACK_TEXT_LIMIT = 8000

const TRUNCATION_NOTICE =
  '\n… card truncated; run `bunx tsx script/deploy/safe/list-pending-proposals.ts` for the full set'

const escapeEntities = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Removes the two mrkdwn markers entity escaping cannot neutralise.
 *
 * A backtick closes the code span a review command sits in and turns the rest of
 * that line into card prose; `*` forges a bold label, which is enough to fake
 * the advisory line. Slack mrkdwn has no escape sequence for either, so the
 * choice is to strip or to let a document value rewrite the card.
 *
 * `_` and `~` are left in place. They only italicise or strike, so they can
 * neither forge a label nor break out of a code span, and removing them renders
 * `alice_smith@example.com` and `alicesmith@example.com` identically on a card
 * whose job is saying who proposed. Many tracked paths carry `_`, so the dirty
 * list — the one field a reviewer copies out to go and look at something — would
 * name files that do not exist.
 */
const stripMarkdownMarkers = (value: string): string =>
  value.replace(/[`*]/g, '')

/**
 * Reduces one proposal-document value to a single line of safe Slack text,
 * capped at `max` code points.
 *
 * `sanitizeProvenanceText` is the repo's shared sanitizer for this data: it
 * strips the control, bidi-override and zero-width characters that let a value
 * repaint or reverse the lines around it, and it coerces non-strings, which is
 * what keeps a half-migrated row from throwing here. The entity escaping on top
 * is Slack's own requirement — without it `<!channel>` in a field nobody reviews
 * would notify a whole channel.
 *
 * Capped before escaping, both because the limits count characters of the
 * underlying value and because capping afterwards could cut an entity in half.
 * By code point, so the cut cannot leave a lone surrogate half behind.
 */
const escapeCapped = (value: unknown, max: number): string =>
  stripMarkdownMarkers(
    escapeEntities([...sanitizeProvenanceText(value)].slice(0, max).join(''))
  )

const escape = (value: unknown): string => escapeCapped(value, MAX_FIELD_CHARS)

/**
 * Renders a URL only if it is one.
 *
 * `captureGitProvenance` stores a PR link only when it starts with `https://`,
 * so a value without that prefix did not reach here through provenance capture.
 * Labelling it `*PR:*` lends it the card's credibility, and Slack auto-links a
 * bare URL, so a signer gets a clickable attacker-chosen destination on the
 * screen they read immediately before approving.
 *
 * Rejection is stated rather than silent: an omitted line reads as "no PR was
 * recorded", which is a different and less alarming fact.
 */
const renderLink = (value: unknown): string => {
  const text = escape(value)
  if (!text) return ''
  // Case-insensitive per RFC 3986.
  if (/^https:\/\//i.test(text)) return text
  // Withheld, not echoed: Slack would auto-link the value this check rejected.
  return '— recorded value is not a link, withheld'
}

/**
 * Joins a list, naming the first few and counting the rest.
 *
 * @param items - Already-escaped values.
 * @param limit - How many to name.
 * @returns The rendered fragment.
 */
const summarise = (items: string[], limit: number): string =>
  items.length <= limit
    ? items.join(', ')
    : `${items.slice(0, limit).join(', ')}, …and ${items.length - limit} more`

const shortHash = (hash: unknown): string =>
  escapeCapped(hash, SHORT_HASH_CHARS)

const describeNetworks = (networks: string[]): string =>
  networks.length <= NAMED_NETWORK_LIMIT
    ? networks.map(escape).join(', ')
    : `${networks.length} networks`

/**
 * Builds the card text.
 *
 * @param proposals - One entry per proposal, newest run only.
 * @param options - The expected-hash table, when a caller has one.
 * @returns Slack-markdown text ready to post.
 * @throws If handed no proposals — an empty card is worse than no post.
 */
export const renderProposalCard = (
  proposals: ICardProposal[],
  options: ICardOptions = {}
): string => {
  const networks = proposals.map((p) => p.network)
  const first = proposals[0]
  if (!first) throw new Error('Cannot render a card for no proposals')

  const count = proposals.length
  const contract = escape(options.contract)
  const what = contract ? `${contract} ` : ''
  const headline =
    count === 1
      ? `1x ${what}proposal created on ${escape(
          first.network
        )} — please sign and schedule 🙏`
      : `${count}x ${what}proposals created across ${describeNetworks(
          networks
        )} — please sign and schedule 🙏`

  const lines = [headline, '']

  // Louder than the headline on purpose. Rows are found per network, and a
  // network whose proposal is missing from this card still has one to sign.
  const expected = options.expectedCount
  if (expected !== undefined && expected > count)
    lines.push(
      `⚠ The run created ${expected} proposals but only ${count} could be listed — ${
        expected - count
      } missing from this card. Check \`bunx tsx script/deploy/safe/list-pending-proposals.ts\`.`,
      ''
    )

  // Absent is stated rather than omitted: a signer needs to know the intent was
  // never captured. Tested after escaping, because a value of nothing but
  // control characters sanitizes to empty and must read as absent, not blank.
  const reason = escapeCapped(first.reason, MAX_PROPOSAL_REASON_LENGTH)
  // Every field below is read from the first row, which is right when a run
  // proposes the same change everywhere and misleading when it does not — the
  // rows are selected per network and nothing forces them to agree.
  // Labelled as the card labels them, so the warning names lines a reader can
  // find rather than source identifiers.
  const COMPARED_FIELDS = {
    reason: 'Reason',
    gitCommit: 'Commit',
    prUrl: 'PR',
    proposerHandle: 'Proposed by',
    checkSummary: 'Proposer-side check',
  } as const
  const differing = (
    Object.keys(COMPARED_FIELDS) as (keyof typeof COMPARED_FIELDS)[]
  )
    // Compared on the raw values, not the rendered ones: a display cap can make
    // two values that diverge past it render identically.
    .filter((field) =>
      proposals.some(
        (p) => String(p[field] ?? '') !== String(first[field] ?? '')
      )
    )
    .map((field) => COMPARED_FIELDS[field])

  lines.push(`*Reason:* ${reason || '_none given_'}`)

  // `gitCommit` is what a signer re-derives calldata against and `prUrl` is the
  // rationale they read, so those diverging matters more than the prose doing
  // so.
  if (differing.length > 0)
    lines.push(
      `⚠ These differ across the networks in this card and only the first is shown: ${differing.join(
        ', '
      )}. Check each network individually.`
    )

  const handle = escape(first.proposerHandle)
  // Union across rows: a non-human actor on any network must not hide behind a
  // human one on another.
  const nonHuman = [
    ...new Set(proposals.map((p) => escape(p.actor)).filter(Boolean)),
  ].filter((a) => a !== 'human')
  // Bounded like any other field: a union grows with the row count, so the list
  // is itself a value that can consume the card.
  const actor =
    nonHuman.length > 0 ? ` (${summarise(nonHuman, NAMED_NETWORK_LIMIT)})` : ''
  lines.push(`*Proposed by:* ${handle || 'unknown'}${actor}`)

  const gitCommit = escapeCapped(first.gitCommit, SHORT_COMMIT_CHARS)
  if (gitCommit) lines.push(`*Commit:* ${gitCommit}`)
  const prUrl = renderLink(first.prUrl)
  if (prUrl) lines.push(`*PR:* ${prUrl}`)

  // A dirty tree means the commit above does not describe what was proposed.
  // Capped at the same limit capture uses.
  //
  // Union across rows: a dirty tree on any network must never read as clean.
  // Three states, matching `provenance-display.ts`'s model for the signing
  // prompt: dirty, capture-incomplete, unreadable. Only a measured empty array
  // with no capture errors is clean.
  //
  // Each state names its OWN networks. Merging them let one path read as the
  // complete inventory across a network that had reported nothing.
  const dirty = proposals.filter(
    (p) => Array.isArray(p.dirtyTreeScoped) && p.dirtyTreeScoped.length > 0
  )
  // A failed `git status` writes an empty list AND capture errors, so an empty
  // list alone does not mean the tree was measured. The likeliest probe
  // failures — the timeout and the buffer cap — correlate with a very dirty
  // tree, so treating this as clean read clean exactly when it was dirtiest.
  const hasCaptureErrors = (p: ICardProposal): boolean =>
    Array.isArray(p.captureErrors) && p.captureErrors.length > 0
  // An empty list plus an error is ambiguous: `captureErrors` is one collector
  // shared by every git probe, so the status probe may have failed or something
  // unrelated may have. Warning is the fail-safe direction; the wording says
  // only what is known.
  const incomplete = proposals.filter(
    (p) =>
      Array.isArray(p.dirtyTreeScoped) &&
      p.dirtyTreeScoped.length === 0 &&
      hasCaptureErrors(p)
  )
  const unreadable = proposals.filter((p) => !Array.isArray(p.dirtyTreeScoped))

  if (dirty.length > 0 || incomplete.length > 0 || unreadable.length > 0) {
    const paths = [
      ...new Set(
        dirty.flatMap((p) => (p.dirtyTreeScoped as unknown[]).map(escape))
      ),
    ].filter(Boolean)

    /** Names the rows a state is about, unless it is the whole card. */
    const on = (rows: ICardProposal[]): string =>
      rows.length === proposals.length
        ? ''
        : ` on ${summarise(
            rows.map((r) => escape(r.network)),
            NAMED_NETWORK_LIMIT
          )}`

    const parts: string[] = []

    if (paths.length > 0) {
      // The count survives the truncation note. Reported alone, "capture
      // stopped counting" was VAGUER than the exact "…and N more" it replaced,
      // so the worse case got the weaker warning.
      const stopped = dirty.some((p) => p.dirtyTreeTruncated === true)
        ? ', and capture stopped counting before the end'
        : ''
      // Both facts, as the signing prompt shows them: reporting only "dirty"
      // loses that the path list may be incomplete, which is the more alarming
      // half of the two.
      const alsoFailed = dirty.some(hasCaptureErrors)
        ? ', and capture reported errors so the list may be incomplete'
        : ''
      parts.push(
        `dirty${on(dirty)} — ${summarise(
          paths,
          MAX_DIRTY_PATHS
        )}${stopped}${alsoFailed}`
      )
    } else if (dirty.length > 0)
      parts.push(`dirty${on(dirty)} — paths unusable`)

    if (incomplete.length > 0)
      parts.push(
        `capture incomplete${on(incomplete)} — a clean reading is unconfirmed`
      )
    if (unreadable.length > 0) parts.push(`not captured${on(unreadable)}`)

    lines.push(`*Working tree:* ${parts.join('; ')}`)
  }

  const checkSummary = escape(first.checkSummary)
  if (checkSummary)
    lines.push(`*Proposer-side check (advisory):* ${checkSummary}`)

  const hashes = options.expectedHashes ?? []
  if (hashes.length > 0) {
    lines.push('', '*Expected code hashes:*')
    hashes.forEach((row) =>
      lines.push(
        `• ${escape(row.network)}: ${escape(row.expected)}${
          row.actual ? ` (on chain ${escape(row.actual)})` : ''
        }`
      )
    )
  }

  // Built separately and appended last, never truncated: it is the only
  // actionable part of the card and it sits at the bottom, so a tail cut would
  // drop precisely the thing the card exists to deliver.
  // Two blanks, not one: this array is concatenated onto the body rather than
  // joined with it, so the first entry supplies the separating newline and the
  // second the blank line that sets the section off.
  const review = ['', '', '*To review:*']
  // One command per network up to the limit, then a single one — the reviewer
  // runs them one network at a time anyway.
  const commandNetworks =
    count <= NAMED_NETWORK_LIMIT ? networks : [first.network]
  commandNetworks.forEach((network, index) => {
    const proposal = proposals[index]
    review.push(
      `• \`bun confirm-safe-tx --network ${escape(network)}\`` +
        (proposal ? `  (${shortHash(proposal.safeTxHash)})` : '')
    )
  })
  if (commandNetworks.length < count)
    review.push(
      `• …and ${count - commandNetworks.length} more — same command per network`
    )

  const reviewText = review.join('\n')
  const card = `${lines.join('\n')}${reviewText}`
  if (card.length <= SLACK_TEXT_LIMIT) return card

  // The middle is what goes, so the headline and the commands both survive.
  // `Math.max` because a negative end makes `slice` cut from the tail instead,
  // which would return a card longer than the cap rather than a shorter one. The
  // budget is positive at today's constants, but it goes negative if
  // NAMED_NETWORK_LIMIT reaches 8 or MAX_FIELD_CHARS reaches ~380.
  let body = lines
    .join('\n')
    .slice(
      0,
      Math.max(
        0,
        SLACK_TEXT_LIMIT - TRUNCATION_NOTICE.length - reviewText.length
      )
    )
  // A code-unit slice can split a surrogate pair or an `&` entity, either of
  // which renders as garbage rather than as a clean cut.
  if (/[\uD800-\uDBFF]$/.test(body)) body = body.slice(0, -1)
  body = body.replace(/&[a-z]{0,3}$/i, '')
  // The shortfall line carries a code span, so a cut can land inside it and
  // leave an unpaired backtick that re-pairs with the review commands below,
  // rendering each command as prose and the prose between as code.
  if ((body.match(/`/g) ?? []).length % 2 === 1)
    body = body.slice(0, body.lastIndexOf('`'))

  return `${body}${TRUNCATION_NOTICE}${reviewText}`
}
