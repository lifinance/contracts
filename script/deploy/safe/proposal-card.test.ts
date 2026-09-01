import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { renderProposalCard, type ICardProposal } from './proposal-card'

const proposal = (overrides: Partial<ICardProposal> = {}): ICardProposal => ({
  network: 'mainnet',
  safeTxHash: `0x${'ab'.repeat(32)}`,
  proposerHandle: 'Alice Example <alice@example.com>',
  actor: 'human',
  reason: 'add AcrossFacetV4 to the whitelist',
  prUrl: 'https://github.com/lifinance/contracts/pull/2125',
  gitCommit: '1234567890abcdef',
  ...overrides,
})

describe('renderProposalCard', () => {
  it('answers who, what, why and how to review, with no manual writing', () => {
    const card = renderProposalCard([proposal()])

    expect(card).toContain('add AcrossFacetV4 to the whitelist')
    // Escaped, because a git identity is angle-bracketed and Slack would read
    // the brackets as markup.
    expect(card).toContain('Alice Example &lt;alice@example.com&gt;')
    expect(card).toContain('https://github.com/lifinance/contracts/pull/2125')
    expect(card).toContain('mainnet')
    // The exact command, not a description of it — the point is zero typing.
    expect(card).toContain('bun confirm-safe-tx --network mainnet')
    // A short hash is enough to match a card to a proposal by eye.
    expect(card).toContain('0xabababab')
    expect(card).not.toContain('ab'.repeat(32))
  })

  it('says so when no reason was given, rather than omitting the line', () => {
    // An absent reason is information: it tells a signer the intent was never
    // stated, which is different from a card that simply did not render it.
    const card = renderProposalCard([proposal({ reason: undefined })])

    expect(card).toMatch(/reason[^\n]*none given/i)
  })

  it('names the network when there is exactly one', () => {
    expect(renderProposalCard([proposal()])).toContain('1x proposal')
  })

  it('counts networks rather than listing them past a handful', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      proposal({ network: `chain${i}` })
    )
    const card = renderProposalCard(many)

    expect(card).toContain('12x proposals')
    // Twelve confirm commands is not a card, it is a wall.
    expect(card.split('bun confirm-safe-tx').length - 1).toBeLessThan(12)
  })

  it('labels a proposer-side check as advisory', () => {
    // Authoritative status lives in the signer-side attestation. A card that
    // states a check result without that word invites signing on its word.
    const card = renderProposalCard([
      proposal({ checkSummary: 'codehash matched on 3/3 networks' }),
    ])

    expect(card).toContain('codehash matched on 3/3 networks')
    expect(card.toLowerCase()).toContain('advisory')
  })

  it('renders the expected-hash table when one is supplied', () => {
    const card = renderProposalCard([proposal()], {
      expectedHashes: [
        { network: 'mainnet', expected: '0xdead', actual: '0xdead' },
      ],
    })

    expect(card).toContain('0xdead')
  })

  it('omits the hash table entirely when there is none', () => {
    // The slot is the parameter, not a placeholder line: shipping "not yet
    // available" filler in an operator card trains people to skip sections.
    const card = renderProposalCard([proposal()])

    expect(card.toLowerCase()).not.toContain('expected code hashes')
  })

  it('marks a bot-created proposal, since who proposed changes how it is read', () => {
    expect(renderProposalCard([proposal({ actor: 'bot' })])).toContain('bot')
  })

  it('escapes Slack control characters in text a proposer controls', () => {
    // A reason reaches Slack verbatim otherwise, and `<!channel>` in a reason
    // would notify everyone from a field nobody reviews.
    const card = renderProposalCard([
      proposal({ reason: '<!channel> & <https://evil.example|click>' }),
    ])

    expect(card).not.toContain('<!channel>')
    expect(card).toContain('&lt;!channel&gt;')
    expect(card).toContain('&amp;')
  })

  it('refuses to render an empty set rather than posting an empty card', () => {
    expect(() => renderProposalCard([])).toThrow(/no proposals/i)
  })

  it('reports a dirty working tree, which changes what the commit means', () => {
    const card = renderProposalCard([
      proposal({ dirtyTreeScoped: ['src/Facets/Foo.sol'] }),
    ])

    expect(card).toContain('src/Facets/Foo.sol')
  })

  it('flattens a newline so a value cannot forge a second card line', () => {
    const card = renderProposalCard([
      proposal({ reason: 'real reason\n*Reason:* forged' }),
    ])

    expect(
      card.split('\n').filter((l) => l.startsWith('*Reason:*'))
    ).toHaveLength(1)
  })

  it('truncates rather than letting Slack drop the review commands', () => {
    const card = renderProposalCard([proposal({ reason: 'x'.repeat(5000) })])

    expect(card.length).toBeLessThanOrEqual(2900)
    expect(card).toContain('card truncated')
  })
})
