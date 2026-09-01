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
    expect(card).toContain('bun confirm-safe-tx --network mainnet')
    expect(card).toContain('0xabababab')
    expect(card).not.toContain('ab'.repeat(32))
  })

  it('says so when no reason was given, rather than omitting the line', () => {
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
    expect(card.split('bun confirm-safe-tx').length - 1).toBeLessThan(12)
  })

  it('labels a proposer-side check as advisory', () => {
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
    const card = renderProposalCard([proposal()])

    expect(card.toLowerCase()).not.toContain('expected code hashes')
  })

  it('marks a bot-created proposal, since who proposed changes how it is read', () => {
    expect(renderProposalCard([proposal({ actor: 'bot' })])).toContain('bot')
  })

  it('escapes Slack control characters in text a proposer controls', () => {
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

  it('keeps the review command when one field is oversized', () => {
    // The review command is the only line that makes the card actionable, so no
    // single proposer-controlled field may push it past the card's cap.
    const card = renderProposalCard([
      proposal({
        reason: 'x'.repeat(5000),
        dirtyTreeScoped: Array.from(
          { length: 3000 },
          (_, i) => `src/F${i}.sol`
        ),
      }),
    ])

    expect(card.length).toBeLessThanOrEqual(2900)
    expect(card).toContain('bun confirm-safe-tx --network mainnet')
    expect(card).toContain('0xabababab')
    expect(card).toContain('*Proposed by:*')
  })

  it('truncates, and stays under the cap, when the card still overflows', () => {
    const card = renderProposalCard([
      proposal({ dirtyTreeScoped: [`src/${'a'.repeat(4000)}.sol`] }),
    ])

    expect(card.length).toBeLessThanOrEqual(2900)
    expect(card).toContain('card truncated')
    // An error-path string never runs in a happy-path test, which is how a
    // command that was never a `bun` alias shipped as the recovery instruction.
    expect(card).toContain(
      'bunx tsx script/deploy/safe/list-pending-proposals.ts'
    )
  })

  it('never cuts a surrogate pair or an entity in half', () => {
    for (const filler of ['\u{1F64F}', '&', 'a'])
      for (let pad = 1; pad <= 6; pad++) {
        const card = renderProposalCard([
          proposal({
            network: 'n'.repeat(pad),
            dirtyTreeScoped: [filler.repeat(4000)],
          }),
        ])
        const body = card.slice(0, card.indexOf('\n… card truncated'))

        expect(card.length).toBeLessThanOrEqual(2900)
        // A lone high surrogate renders as U+FFFD; a bare `&am` as literal junk.
        expect(/[\uD800-\uDBFF]$/.test(body)).toBe(false)
        expect(/&[a-z]{0,3}$/i.test(body)).toBe(false)
      }
  })

  it('escapes the short hash, not only the fields around it', () => {
    // `<!channel>` is exactly SHORT_HASH_CHARS long, so an unescaped slice of a
    // hand-edited safeTxHash notified the whole channel from the one field the
    // renderer trusted.
    const card = renderProposalCard([proposal({ safeTxHash: '<!channel>' })])

    expect(card).not.toContain('<!channel>')
    expect(card).toContain('&lt;!channel&gt;')
  })

  it('strips control and bidi characters from every rendered field', () => {
    // EXSC-693: collapsing `\s+` does not touch Cc/Cf, so ANSI escapes and the
    // bidi overrides behind Trojan Source reached the card unfiltered. Asserted
    // per field, because the length-capped fields and the uncapped ones reach
    // Slack by different escape paths.
    const payload = '\u001b[2K\u202ereversed\u200bhidden\u0007'
    const banned = ['\u001b', '\u202e', '\u200b', '\u0007']
    const fields: (keyof ICardProposal)[] = [
      'reason',
      'proposerHandle',
      'actor',
      'prUrl',
      'gitCommit',
      'checkSummary',
      'network',
      'safeTxHash',
    ]

    for (const field of fields) {
      const card = renderProposalCard([
        proposal({ [field]: `clean${payload}` }),
      ])
      for (const bad of banned) expect(card).not.toContain(bad)
    }

    const inList = renderProposalCard([
      proposal({ dirtyTreeScoped: [`src/F.sol${payload}`] }),
    ])
    for (const bad of banned) expect(inList).not.toContain(bad)

    const inHashTable = renderProposalCard([proposal()], {
      expectedHashes: [
        { network: `mainnet${payload}`, expected: `0xdead${payload}` },
      ],
    })
    for (const bad of banned) expect(inHashTable).not.toContain(bad)

    expect(
      renderProposalCard([proposal({ reason: `clean${payload}` })])
    ).toContain('clean[2Kreversedhidden')
  })

  it('renders a legacy row whose fields are not strings', () => {
    // A row stored before provenance capture, or hand-edited, can hold a number
    // or null anywhere. Throwing here silently downgrades the whole card to the
    // old count-only line, making the worse message permanent for that row.
    const legacy = {
      network: 'mainnet',
      safeTxHash: 12345,
      proposerHandle: null,
      actor: 7,
      reason: {},
      prUrl: [],
      gitCommit: 999,
      dirtyTreeScoped: 'not-an-array',
    } as unknown as ICardProposal

    const card = renderProposalCard([legacy])

    expect(card).toContain('1x proposal created on mainnet')
    expect(card).toContain('bun confirm-safe-tx --network mainnet')
  })

  it('caps the dirty list and says how many it dropped', () => {
    const card = renderProposalCard([
      proposal({
        dirtyTreeScoped: Array.from({ length: 25 }, (_, i) => `src/F${i}.sol`),
      }),
    ])

    expect(card).toContain('src/F0.sol')
    expect(card).toContain('and 5 more')
    expect(card).not.toContain('src/F24.sol')
  })

  it('reads a whitespace-only reason as absent rather than blank', () => {
    const card = renderProposalCard([proposal({ reason: '    ' })])

    expect(card).toMatch(/reason[^\n]*none given/i)
  })
})
