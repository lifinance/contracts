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
}

/**
 * Cap for the whole card.
 *
 * Nothing downstream truncates — `send-slack-webhook-message.ts` posts the text
 * verbatim and `SlackNotifier` only caps the `blocks[].text` fields it builds
 * itself — so an over-long card would reach Slack whole and lose its bottom to
 * the client's own collapsing. Cutting here keeps the loss visible.
 */
const SLACK_TEXT_LIMIT = 2900

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
const escape = (value: unknown): string =>
  escapeEntities(sanitizeProvenanceText(value))

/**
 * Escapes a value whose length is capped.
 *
 * Capped before escaping, both because the limits count characters of the
 * underlying value and because capping afterwards could cut an entity in half.
 * By code point, so the cut cannot leave a lone surrogate half behind.
 */
const escapeCapped = (value: unknown, max: number): string =>
  escapeEntities([...sanitizeProvenanceText(value)].slice(0, max).join(''))

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
  const headline =
    count === 1
      ? `1x proposal created on ${escape(
          first.network
        )} — please sign and schedule 🙏`
      : `${count}x proposals created across ${describeNetworks(
          networks
        )} — please sign and schedule 🙏`

  const lines = [headline, '']

  // Absent is stated rather than omitted: a signer needs to know the intent was
  // never captured. Tested after escaping, because a value of nothing but
  // control characters sanitizes to empty and must read as absent, not blank.
  const reason = escapeCapped(first.reason, MAX_PROPOSAL_REASON_LENGTH)
  lines.push(`*Reason:* ${reason || '_none given_'}`)

  const handle = escape(first.proposerHandle)
  const actorName = escape(first.actor)
  const actor = actorName && actorName !== 'human' ? ` (${actorName})` : ''
  lines.push(`*Proposed by:* ${handle || 'unknown'}${actor}`)

  const gitCommit = escapeCapped(first.gitCommit, SHORT_COMMIT_CHARS)
  if (gitCommit) lines.push(`*Commit:* ${gitCommit}`)
  const prUrl = escape(first.prUrl)
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

  lines.push('', '*To review:*')
  // One command per network up to the limit, then a single one — the reviewer
  // runs them one network at a time anyway.
  const commandNetworks =
    count <= NAMED_NETWORK_LIMIT ? networks : [first.network]
  commandNetworks.forEach((network, index) => {
    const proposal = proposals[index]
    lines.push(
      `• \`bun confirm-safe-tx --network ${escape(network)}\`` +
        (proposal ? `  (${shortHash(proposal.safeTxHash)})` : '')
    )
  })
  if (commandNetworks.length < count)
    lines.push(
      `• …and ${count - commandNetworks.length} more — same command per network`
    )

  const card = lines.join('\n')
  if (card.length <= SLACK_TEXT_LIMIT) return card

  let body = card.slice(0, SLACK_TEXT_LIMIT - TRUNCATION_NOTICE.length)
  // A code-unit slice can split a surrogate pair or an `&amp;` entity, either of
  // which renders as garbage rather than as a clean cut.
  if (/[\uD800-\uDBFF]$/.test(body)) body = body.slice(0, -1)
  body = body.replace(/&[a-z]{0,3}$/i, '')
  return `${body}${TRUNCATION_NOTICE}`
}
