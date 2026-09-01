/**
 * Renders the signing-ask card for a set of Safe proposals.
 *
 * Replaces a message assembled from the runner's own progress file, which knew
 * a contract name and a network count and nothing about intent. Everything here
 * comes from the proposal documents, so the card is a view of the record rather
 * than a second, hand-written account of it.
 *
 * Pure: it takes rows and returns text. Reading Mongo and posting live in
 * `post-proposal-card.ts`.
 */

/** How many networks are named individually before the card switches to a count. */
const NAMED_NETWORK_LIMIT = 4

/** Enough of a hash to match a card to a proposal by eye. */
const SHORT_HASH_CHARS = 10

/** One proposal, flattened from its document and provenance block. */
export interface ICardProposal {
  network: string
  safeTxHash: string
  proposerHandle?: string
  actor?: string
  reason?: string
  prUrl?: string
  gitCommit?: string
  dirtyTreeScoped?: string[]
  /**
   * Result of a check the PROPOSER ran. Rendered as advisory: the authoritative
   * status is the signer-side attestation, and a card that states a result
   * without saying so invites signing on the card's word.
   */
  checkSummary?: string
}

/** One row of the per-network expected-hash table (WP-2.x / WP-7.2 fill this). */
export interface IExpectedHashRow {
  network: string
  expected: string
  actual?: string
}

export interface ICardOptions {
  /**
   * Rendered only when supplied. The slot is this parameter, not a placeholder
   * line: filler sections in an operator card train people to skip sections.
   */
  expectedHashes?: IExpectedHashRow[]
}

/** Slack renders at most this much text; `SlackNotifier` truncates at the same point. */
const SLACK_TEXT_LIMIT = 2900

/**
 * Escapes Slack markup and flattens the value onto one line.
 *
 * Applied to every string that came out of a proposal document. Two distinct
 * risks: `<!channel>` in a field nobody reviews would notify a whole channel,
 * and a newline lets a value forge the card's own structure — a reason
 * containing `\n*Reason:* something else` would render as a second, plausible
 * Reason line. Values are sanitized when stored, but a card that trusts the
 * document is one hand-edited row away from lying to every signer who reads it.
 */
const escape = (value: string): string =>
  value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

const shortHash = (hash: string): string => hash.slice(0, SHORT_HASH_CHARS)

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

  // Absent is stated rather than omitted: "none given" tells a signer the intent
  // was never captured, which is different from a card that failed to render it.
  lines.push(
    `*Reason:* ${first.reason ? escape(first.reason) : '_none given_'}`
  )

  const actor =
    first.actor && first.actor !== 'human' ? ` (${escape(first.actor)})` : ''
  lines.push(
    `*Proposed by:* ${
      first.proposerHandle ? escape(first.proposerHandle) : 'unknown'
    }${actor}`
  )

  if (first.gitCommit)
    lines.push(`*Commit:* ${escape(first.gitCommit.slice(0, 12))}`)
  if (first.prUrl) lines.push(`*PR:* ${escape(first.prUrl)}`)

  // A dirty tree means the commit above does not describe what was proposed.
  const dirty = first.dirtyTreeScoped ?? []
  if (dirty.length > 0)
    lines.push(`*Working tree:* dirty — ${dirty.map(escape).join(', ')}`)

  if (first.checkSummary)
    lines.push(
      `*Proposer-side check (advisory):* ${escape(first.checkSummary)}`
    )

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
  // One command per network up to the limit, then a single one: a dozen commands
  // is a wall, not a card, and the reviewer runs them one network at a time
  // anyway.
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
  // Slack drops everything past the limit silently, and the review commands are
  // at the bottom — so an over-long card loses precisely the part that makes it
  // useful. Truncating here keeps the loss visible.
  return card.length <= SLACK_TEXT_LIMIT
    ? card
    : `${card.slice(
        0,
        SLACK_TEXT_LIMIT - 80
      )}\n… card truncated; run \`bun list-pending-proposals\` for the full set`
}
