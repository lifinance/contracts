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

import { MAX_PROPOSAL_REASON_LENGTH } from './safe-utils'

/** How many networks are named individually before the card switches to a count. */
const NAMED_NETWORK_LIMIT = 4

/** Enough of a hash to match a card to a proposal by eye. */
const SHORT_HASH_CHARS = 10

/** Commit prefix long enough to be unambiguous in this repo. */
const SHORT_COMMIT_CHARS = 12

/**
 * Cap for every other single field.
 *
 * The card's own cap is not enough on its own: an oversized `contract`,
 * `prUrl`, `proposerHandle`, `checkSummary` or network name each individually
 * consumed the whole budget and pushed the review command — the one line that
 * makes the card actionable — off the bottom.
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
 * Not 3000: that is the per-`blocks[].text` limit, and this card posts as a
 * top-level `text`, whose limit is 40,000. Truncating at the block figure threw
 * away the review commands — the point of the card — to save bytes Slack would
 * have accepted. Held well below 40,000 anyway, because a card nobody scrolls
 * to the end of has already failed.
 */
export const SLACK_TEXT_LIMIT = 8000

const TRUNCATION_NOTICE =
  '\n… card truncated; run `bunx tsx script/deploy/safe/list-pending-proposals.ts` for the full set'

const escapeEntities = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Reduces one proposal-document value to a single line of safe Slack text.
 *
 * `sanitizeProvenanceText` is the repo's shared sanitizer for this data
 * (EXSC-693): it strips the control, bidi-override and zero-width characters
 * that let a value repaint or reverse the lines around it, and it coerces
 * non-strings, which is what keeps a half-migrated row from throwing here. The
 * entity escaping on top is Slack's own requirement — without it `<!channel>`
 * in a field nobody reviews would notify a whole channel.
 */
/**
 * Removes the mrkdwn markers Slack acts on and entities cannot neutralise.
 *
 * A backtick closes the code span the review command sits in and turns the rest
 * of that line into card prose; `*` and `_` forge a bold or italic label inline,
 * which is enough to fake the advisory line. Slack mrkdwn has no escape
 * sequence for either, so the choice is to strip or to let a document value
 * rewrite the card.
 *
 * `_` and `~` are deliberately NOT stripped. They only italicise or strike
 * text, so they cannot forge a label or break out of a code span — and
 * stripping them corrupted real data: `alice_smith@example.com` and
 * `alicesmith@example.com` rendered byte-identically on a card whose job is
 * saying who proposed, and 115 tracked paths in this repo carry `_`, so a dirty
 * path rendered as a file that does not exist. That list is the one field a
 * reviewer copies out to go and look at something.
 */
const stripMarkdownMarkers = (value: string): string =>
  value.replace(/[`*]/g, '')

/**
 * Escapes a value whose length is capped.
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
 * so a value that does not reach here through provenance capture. Labelling it
 * `*PR:*` lends it the card's credibility, and Slack auto-links a bare URL, so
 * a signer gets a clickable attacker-chosen destination on the screen they read
 * immediately before approving.
 *
 * Rejection is stated rather than silent: an omitted line reads as "no PR was
 * recorded", which is a different and less alarming fact.
 */
const renderLink = (value: unknown): string => {
  const text = escape(value)
  if (!text) return ''
  return text.startsWith('https://') ? text : `${text} — not a link, ignored`
}

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
  // Compared on the raw values, not the rendered ones: two reasons identical for
  // 200 characters and divergent after were reported as agreeing.
  const differing = (
    ['reason', 'gitCommit', 'prUrl', 'proposerHandle'] as const
  )
    .filter((field) =>
      proposals.some(
        (p) => String(p[field] ?? '') !== String(first[field] ?? '')
      )
    )
    .map((field) => (field === 'prUrl' ? 'PR' : field))

  lines.push(`*Reason:* ${reason || '_none given_'}`)

  // `gitCommit` is what a signer re-derives calldata against and `prUrl` is the
  // rationale they read, so those diverging matters more than the prose doing
  // so. The first version of this flagged only the prose, which is the least
  // consequential member of the set.
  if (differing.length > 0)
    lines.push(
      `⚠ These differ across the networks in this card and only the first is shown: ${differing.join(
        ', '
      )}. Check each network individually.`
    )

  const handle = escape(first.proposerHandle)
  const actorName = escape(first.actor)
  const actor = actorName && actorName !== 'human' ? ` (${actorName})` : ''
  lines.push(`*Proposed by:* ${handle || 'unknown'}${actor}`)

  const gitCommit = escapeCapped(first.gitCommit, SHORT_COMMIT_CHARS)
  if (gitCommit) lines.push(`*Commit:* ${gitCommit}`)
  const prUrl = renderLink(first.prUrl)
  if (prUrl) lines.push(`*PR:* ${prUrl}`)

  // A dirty tree means the commit above does not describe what was proposed.
  // Capped at the same limit capture uses, so a hand-edited row cannot push the
  // review commands off the bottom of the card.
  const dirty: unknown[] = Array.isArray(first.dirtyTreeScoped)
    ? first.dirtyTreeScoped
    : []
  if (dirty.length > 0) {
    const shown = dirty.slice(0, MAX_DIRTY_PATHS).map(escape).filter(Boolean)
    const more =
      dirty.length > MAX_DIRTY_PATHS
        ? `, …and ${dirty.length - MAX_DIRTY_PATHS} more`
        : ''
    lines.push(`*Working tree:* dirty — ${shown.join(', ')}${more}`)
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

  // Built separately and appended last, never truncated. It is the only
  // actionable part of the card, and it sits at the bottom — so a tail-truncated
  // card lost precisely the thing it exists to deliver. Measured: every
  // overflowing card dropped the whole review section.
  const review = ['', '*To review:*']
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
  let body = lines
    .join('\n')
    .slice(0, SLACK_TEXT_LIMIT - TRUNCATION_NOTICE.length - reviewText.length)
  // A code-unit slice can split a surrogate pair or an `&` entity, either of
  // which renders as garbage rather than as a clean cut.
  if (/[\uD800-\uDBFF]$/.test(body)) body = body.slice(0, -1)
  body = body.replace(/&[a-z]{0,3}$/i, '')

  return `${body}${TRUNCATION_NOTICE}${reviewText}`
}
