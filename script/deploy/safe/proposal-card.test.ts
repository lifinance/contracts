/**
 * Tests for the Slack signing-ask card (EXSC-696).
 *
 * The properties that matter are the ones a signer relies on: no document value
 * can forge the card's structure or borrow its authority, the card can never
 * read cleaner than the working tree it describes or understate how many
 * proposals are waiting, and the review commands survive every truncation path.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  SLACK_TEXT_LIMIT,
  renderProposalCard,
  type ICardProposal,
} from './proposal-card'

const proposal = (overrides: Partial<ICardProposal> = {}): ICardProposal => ({
  network: 'mainnet',
  safeTxHash: `0x${'ab'.repeat(32)}`,
  proposerHandle: 'Alice Example <alice@example.com>',
  actor: 'human',
  reason: 'add AcrossFacetV4 to the whitelist',
  prUrl: 'https://github.com/lifinance/contracts/pull/2125',
  gitCommit: '1234567890abcdef',
  // A measured empty array, which is what capture writes for a clean tree and
  // the only shape the card reads as clean. Load-bearing for the tests below
  // that name networks or measure the line's bound: an uncaptured default row
  // renders a working-tree line of its own and collapses the `(on …)`
  // qualifier those assertions look for.
  dirtyTreeScoped: [],
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

    expect(card.length).toBeLessThanOrEqual(SLACK_TEXT_LIMIT)
    expect(card).toContain('bun confirm-safe-tx --network mainnet')
    expect(card).toContain('0xabababab')
    expect(card).toContain('*Proposed by:*')
  })

  it('truncates, and stays under the cap, when the card still overflows', () => {
    // Every single field is capped now, so no one of them can overflow the card
    // on its own. The hash table's ROW COUNT is not capped, and each `&` in a
    // value becomes five characters once escaped — so this is what an overflow
    // actually looks like, rather than one enormous string.
    const card = renderProposalCard([proposal({ reason: '&'.repeat(200) })], {
      expectedHashes: Array.from({ length: 200 }, (_, i) => ({
        network: `chain${i}`,
        expected: `0x${'ab'.repeat(32)}`,
        actual: `0x${'cd'.repeat(32)}`,
      })),
    })

    expect(card.length).toBeLessThanOrEqual(SLACK_TEXT_LIMIT)
    expect(card).toContain('card truncated')
    // An error-path string never runs in a happy-path test, which is how a
    // command that was never a `bun` alias shipped as the recovery instruction.
    expect(card).toContain(
      'bunx tsx script/deploy/safe/list-pending-proposals.ts'
    )
  })

  it('keeps the review commands on an overflowing card', () => {
    // They are the only actionable part and they sit at the bottom, so a tail
    // cut would drop exactly the thing the card exists to deliver.
    const card = renderProposalCard(
      ['mainnet', 'arbitrum'].map((network) => ({
        network,
        safeTxHash: `0x${'ab'.repeat(32)}`,
      })),
      {
        expectedHashes: Array.from({ length: 200 }, (_, i) => ({
          network: `chain${i}`,
          expected: `0x${'ab'.repeat(32)}`,
        })),
      }
    )

    expect(card).toContain('card truncated')
    expect(card).toContain('*To review:*')
    expect(card).toContain('bun confirm-safe-tx --network mainnet')
    expect(card).toContain('bun confirm-safe-tx --network arbitrum')
    expect(card.length).toBeLessThanOrEqual(SLACK_TEXT_LIMIT)
  })

  it('keeps underscores and tildes, which real paths and emails contain', () => {
    // Stripping these mangles real data for no security gain: they only
    // italicise or strike text, so they cannot forge a label or break out of a
    // code span, while `alice_smith@…` and `alicesmith@…` render identically on
    // a card whose job is saying who proposed, and many tracked paths in this
    // repo carry an underscore.
    const card = renderProposalCard([
      proposal({
        proposerHandle: 'A B <alice_smith@example.com>',
        dirtyTreeScoped: ['.github/pull_request_template.md'],
        reason: 'bump ~1.2.0',
      }),
    ])

    expect(card).toContain('alice_smith@example.com')
    expect(card).toContain('.github/pull_request_template.md')
    expect(card).toContain('~1.2.0')
  })

  it('flags a divergent commit or PR, not only a divergent reason', () => {
    // gitCommit is what a signer re-derives calldata against and prUrl is the
    // rationale they read, so these diverging matters more than the prose doing
    // so.
    const card = renderProposalCard([
      proposal(),
      proposal({
        network: 'arbitrum',
        gitCommit: 'ffffffffffff',
        prUrl: 'https://github.com/lifinance/contracts/pull/999',
        proposerHandle: 'Bob Other <bob@example.com>',
      }),
    ])

    // The warning names the card's own labels, so asserted on the whole
    // sentence — `PR` and `Commit` both occur elsewhere on the card.
    const warning = card.split('\n').find((l) => l.startsWith('⚠ These differ'))

    expect(warning).toContain('Commit')
    expect(warning).toContain('PR')
    expect(warning).toContain('Proposed by')
  })

  it('never cuts a surrogate pair or an entity in half', () => {
    for (const filler of ['\u{1F64F}', '&', 'a'])
      for (let pad = 1; pad <= 6; pad++) {
        // The overflow has to come from the row COUNT: every field is capped, so
        // no single value can reach the card's cap on its own. `pad` walks the
        // cut one character at a time so it lands mid-pair and mid-entity.
        const card = renderProposalCard(
          [proposal({ network: 'n'.repeat(pad) })],
          {
            expectedHashes: Array.from({ length: 40 }, () => ({
              network: filler.repeat(200),
              expected: filler.repeat(200),
            })),
          }
        )
        const cut = card.indexOf('\n… card truncated')
        const body = card.slice(0, cut)

        // Without this the assertions below run against a whole, uncut card and
        // prove nothing about the cut.
        expect(cut).toBeGreaterThan(0)
        expect(card.length).toBeLessThanOrEqual(SLACK_TEXT_LIMIT)
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
    // Collapsing `\s+` does not touch Cc/Cf, so ANSI escapes and the bidi
    // overrides behind Trojan Source need their own removal. Asserted per field,
    // because the length-capped fields and the uncapped ones reach Slack by
    // different escape paths.
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

describe('renderProposalCard — values cannot forge card structure', () => {
  it('strips markdown markers that entity-escaping does not neutralise', () => {
    // A backtick closes the code span the review command sits in, and the text
    // after it renders as card prose. `*` and `_` forge a bold label inline, so
    // a reason can fake the advisory line. Slack mrkdwn has no escape sequence
    // for these, so the only options are strip or let them through.
    const card = renderProposalCard([
      proposal({
        network: 'main`net`*URGENT: already reviewed, just sign*',
        reason: '*Proposer-side check (advisory):* all clear',
      }),
    ])

    expect(card).not.toContain('`URGENT')
    expect(card).not.toContain('*URGENT')
    // Exactly one code span opens and closes on the command line.
    const commandLine = card
      .split('\n')
      .find((l) => l.includes('confirm-safe-tx'))
    expect((commandLine?.match(/`/g) ?? []).length).toBe(2)
    // And the forged advisory label is inert. Checked as "no stray marker
    // survives on the reason line", not as "no line starts with the label" —
    // the forgery renders mid-line, so the line-start form passed regardless.
    const reasonLine = card.split('\n').find((l) => l.startsWith('*Reason:*'))
    expect(reasonLine).toBeDefined()
    expect((reasonLine?.match(/\*/g) ?? []).length).toBe(2)
  })

  it('neutralises a control sequence in the hash, which is not a hex string', () => {
    // `<!channel>` is exactly the short-hash width, so it survived the slice
    // unescaped and notified the channel from the one field the renderer
    // trusted.
    const card = renderProposalCard([proposal({ safeTxHash: '<!channel>' })])

    expect(card).not.toContain('<!channel>')
  })
})

describe('renderProposalCard — it cannot understate the ask', () => {
  it('says so when fewer proposals were found than the run created', () => {
    // A card reading "38x proposals" after 41 networks succeeded leaves three
    // proposals that nobody is told to sign. Undercounting the signing ask is
    // the one error here with a direct safety consequence.
    const card = renderProposalCard(
      [proposal(), proposal({ network: 'arbitrum' })],
      {
        expectedCount: 5,
      }
    )

    // Not `toContain('5')`: the fixture commit is `1234567890ab`, so that
    // matched with no shortfall line rendered at all.
    expect(card).toContain('created 5 proposals')
    expect(card.toLowerCase()).toMatch(/only 2|3 (missing|not found)/)
  })

  it('stays quiet when the counts agree', () => {
    const card = renderProposalCard([proposal()], { expectedCount: 1 })

    expect(card.toLowerCase()).not.toContain('missing')
  })

  it('names the contract in the headline, which the message it replaces did', () => {
    // A name absent from every other fixture field, and asserted on the headline
    // rather than the whole card: the default fixture's reason mentions
    // AcrossFacetV4, so `toContain` on the card passed with no headline change.
    const headline = renderProposalCard([proposal()], {
      contract: 'WhitelistManagerFacet',
    }).split('\n')[0]

    expect(headline).toContain('WhitelistManagerFacet')
  })

  it('flags divergent reasons rather than printing the first as if it covered all', () => {
    const card = renderProposalCard([
      proposal({ reason: 'reason A' }),
      proposal({ network: 'arbitrum', reason: 'reason B' }),
    ])

    expect(card.toLowerCase()).toContain('differ')
  })
})

describe('renderProposalCard — the PR link is a link, or it is not shown', () => {
  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>x</script>'],
    ['file:', 'file:///etc/passwd'],
    ['plain http', 'http://evil.example/pull/1'],
    ['a bare word', 'nope'],
    ['a protocol-relative URL', '//evil.example/pull/1'],
  ])('does not present a %s value as a link', (_label, prUrl) => {
    // The capture path already accepts only https, so a value that is not one
    // reached the document by hand. Presenting it as a PR lends it the card's
    // credibility, and Slack auto-links a bare URL.
    const card = renderProposalCard([proposal({ prUrl })])

    // Exact equality on the whole line, so non-echo is asserted for every value
    // in the table rather than for `javascript:` alone. The earlier
    // `not.toMatch(/\*PR:\* \S+$/m)` form was satisfied by a renderer that
    // echoed the value ahead of its own trailing prose, so it observed nothing —
    // and a substring check cannot see an echo that escaping has altered.
    expect(card.split('\n').find((l) => l.startsWith('*PR:*'))).toBe(
      '*PR:* — recorded value is not a link, withheld'
    )
  })

  it('keeps a real https PR link', () => {
    expect(
      renderProposalCard([
        proposal({ prUrl: 'https://github.com/lifinance/contracts/pull/2125' }),
      ])
    ).toContain('*PR:* https://github.com/lifinance/contracts/pull/2125')
  })

  it('says a link was rejected rather than staying silent about it', () => {
    // Silently omitting looks identical to "no PR was recorded", which is a
    // different fact and a less alarming one.
    expect(
      renderProposalCard([proposal({ prUrl: 'javascript:alert(1)' })])
    ).toContain('not a link')
  })

  it('does not treat an https prefix inside a longer scheme as https', () => {
    expect(
      renderProposalCard([
        proposal({ prUrl: 'nothttps://github.com/x/pull/1' }),
      ])
    ).toContain('not a link')
  })
})

describe('renderProposalCard — a warning about one network is not a claim about all', () => {
  it('reports a dirty tree when ANY network had one, naming which', () => {
    // The union across the card, not a property of row zero: one network's
    // dirty tree must not read as clean because another network's is.
    const card = renderProposalCard([
      proposal({ network: 'mainnet' }),
      proposal({
        network: 'arbitrum',
        dirtyTreeScoped: ['src/Facets/Foo.sol'],
      }),
    ])

    // Asserted on the working-tree line, which is `undefined` when the line is
    // absent. A whole-card `toContain('arbitrum')` matched the per-network
    // review command, so it passed with no qualifier rendered at all.
    const workingTree = card
      .split('\n')
      .find((l) => l.startsWith('*Working tree:*'))

    expect(workingTree).toContain('src/Facets/Foo.sol')
    expect(workingTree).toContain('on arbitrum')
  })

  it('does not claim a clean tree when the first row happens to be clean', () => {
    const clean = renderProposalCard([
      proposal(),
      proposal({ network: 'base' }),
    ])

    expect(clean).not.toContain('*Working tree:*')
  })

  it('marks a bot when ANY network was proposed by one', () => {
    // A bot-proposed network must not hide behind a human-proposed one; who
    // proposed changes how a signer reads the whole card.
    const card = renderProposalCard([
      proposal({ actor: 'human' }),
      proposal({ network: 'arbitrum', actor: 'bot' }),
    ])

    expect(card).toContain('bot')
  })

  it('flags a divergent advisory check rather than presenting the first as general', () => {
    const card = renderProposalCard([
      proposal({ checkSummary: 'codehash matched' }),
      proposal({ network: 'arbitrum', checkSummary: 'codehash MISMATCH' }),
    ])

    // The card's own label, not the source field name — a signer reads labels.
    // Asserted on the DIVERGENCE line, not merely on the label — the advisory
    // line carries the same label, so `toContain` on it passed regardless.
    const warning = card.split('\n').find((l) => l.startsWith('⚠ These differ'))
    expect(warning).toContain('Proposer-side check')
  })
})

describe('renderProposalCard — a rejected link is not echoed', () => {
  it.each([
    ['uppercase scheme', 'HTTPS://evil.example/pull/1'],
    ['mixed-case scheme', 'HtTpS://evil.example/pull/1'],
  ])('accepts %s, since the scheme is case-insensitive', (_label, prUrl) => {
    // RFC 3986 makes the scheme case-insensitive, and Slack auto-links what it
    // recognises.
    //
    // Exact equality on the whole line. A case-SENSITIVE renderer that echoed
    // the rejected value emitted `*PR:* HTTPS://… — not a link, ignored`, which
    // satisfies both `toContain('*PR:* HTTPS://…')` and
    // `not.toContain('withheld')` — so the substring pair passed against the
    // very renderer this test exists to rule out.
    const prLine = renderProposalCard([proposal({ prUrl })])
      .split('\n')
      .find((l) => l.startsWith('*PR:*'))

    expect(prLine).toBe(`*PR:* ${prUrl}`)
  })

  it('does not reproduce a rejected value', () => {
    // Echoing it puts the attacker's string on the card and lets Slack link it.
    const card = renderProposalCard([
      proposal({ prUrl: 'javascript:alert(1)' }),
    ])

    expect(card).not.toContain('javascript')
    expect(card).not.toContain('alert')
    expect(card).toContain('not a link')
  })
})

describe('renderProposalCard — an unreadable dirty-tree field is not clean', () => {
  it.each([
    ['a string', 'src/Facets/Foo.sol'],
    ['an object', { a: 1 }],
    ['a number', 7],
    ['null', null],
  ])(
    'warns when dirtyTreeScoped is %s, rather than reading as clean',
    (_label, dirtyTreeScoped) => {
      // A legacy or hand-edited row can hold any shape here, and only a
      // measured empty array may read as clean, so every other shape warns.
      const card = renderProposalCard([
        proposal(),
        proposal({ network: 'arbitrum', dirtyTreeScoped }),
      ])

      const line = card.split('\n').find((l) => l.startsWith('*Working tree:*'))
      expect(line).toBeDefined()
      expect(line).toContain('arbitrum')
      // On the state word, not only the detail: `/not captured/` alone is
      // satisfied by the "paths not captured" fragment, which leaves the word
      // that says whether the tree is clean unasserted.
      expect(line).toMatch(/^\*Working tree:\* not captured\b/)
      expect(line).not.toMatch(/\bclean\b/i)
    }
  )
})

describe('renderProposalCard — the unions cannot become the overflow', () => {
  /** Same shape at two very different row counts; the line must not grow. */
  const lineAt = (
    rows: number,
    label: string,
    build: (i: number) => ICardProposal
  ): number => {
    const line = renderProposalCard([
      // Must stay clean. An uncaptured guard row puts every row into
      // `reported`, which collapses the `(on …)` qualifier and leaves the delta
      // assertion below measuring a list that is not rendered at all.
      proposal({ network: 'clean-one' }),
      ...Array.from({ length: rows }, (_, i) => build(i)),
    ])
      .split('\n')
      .find((l) => l.startsWith(label))

    // Throws rather than defaulting to 0. A `?? 0` here let an ABSENT line
    // satisfy the delta assertion below — unbounded growth truncated the line
    // off the card entirely, and the test passed on its absence.
    if (line === undefined)
      throw new Error(`no line starting "${label}" at ${rows} rows`)
    return line.length
  }

  // Asserted as "does not scale with the row count" rather than against a
  // character threshold. A threshold is a guess that has to be retuned whenever
  // a cap moves; not scaling is the property that makes a union safe to add.
  it('bounds the network list on the working-tree line', () => {
    const build = (i: number): ICardProposal =>
      proposal({
        network: `chain${'n'.repeat(300)}${i}`,
        dirtyTreeScoped: ['src/Facets/Foo.sol'],
      })

    const small = lineAt(5, '*Working tree:*', build)
    const large = lineAt(400, '*Working tree:*', build)

    expect(small).toBeGreaterThan(0)
    // 80× the rows may add only the digits of the "…and N more" count. Growth
    // proportional to the row count is the defect: unbounded, this line measured
    // 7,556 characters.
    expect(large - small).toBeLessThan(10)
  })

  it('bounds the actor list', () => {
    const build = (i: number): ICardProposal =>
      // Index FIRST: with it last, every actor truncates to the same 200
      // characters at the field cap, dedupes to one, and the fixture measures a
      // bound that was already there.
      proposal({ network: `chain${i}`, actor: `bot-${i}-${'a'.repeat(200)}` })

    const small = lineAt(5, '*Proposed by:*', build)
    const large = lineAt(400, '*Proposed by:*', build)

    expect(small).toBeGreaterThan(0)
    expect(large - small).toBeLessThan(10)
  })
})

describe('renderProposalCard — the dirty-path list cannot understate itself', () => {
  it('says so when capture truncated the path list', () => {
    // Exactly MAX_DIRTY_PATHS paths is the length `summarise` calls exact, so
    // it is the one length at which a floor renders as an inventory.
    const card = renderProposalCard([
      proposal({
        dirtyTreeScoped: Array.from({ length: 20 }, (_, i) => `src/F${i}.sol`),
        dirtyTreeTruncated: true,
      }),
    ])

    const line = card.split('\n').find((l) => l.startsWith('*Working tree:*'))
    expect(line).toMatch(/stopped counting/)
  })

  it('stays exact when capture was not truncated', () => {
    const card = renderProposalCard([
      proposal({
        dirtyTreeScoped: Array.from({ length: 20 }, (_, i) => `src/F${i}.sol`),
      }),
    ])

    const line = card.split('\n').find((l) => l.startsWith('*Working tree:*'))
    expect(line).not.toMatch(/more/)
  })
})

describe('renderProposalCard — an uncaptured working tree is not a clean one', () => {
  it('reports an absent dirtyTreeScoped rather than rendering nothing', () => {
    // Only a measured empty array may read as clean, which is the rule
    // `provenance-display.ts` holds for the signing prompt.
    const card = renderProposalCard([
      proposal({ dirtyTreeScoped: undefined }),
      proposal({ network: 'arbitrum', dirtyTreeScoped: undefined }),
    ])

    const line = card.split('\n').find((l) => l.startsWith('*Working tree:*'))
    expect(line).toBe('*Working tree:* not captured')
  })

  it('is silent only for a measured empty array', () => {
    const card = renderProposalCard([
      proposal({ dirtyTreeScoped: [] }),
      proposal({ network: 'arbitrum', dirtyTreeScoped: [] }),
    ])

    expect(card).not.toContain('*Working tree:*')
  })
})

describe('renderProposalCard — a failed capture is the loudest case, not the quietest', () => {
  it('reports capture errors on a row whose path list is an empty array', () => {
    // A failed `git status` probe writes dirtyTreeScoped: [] AND captureErrors.
    // The card mapped neither, so the row fell in neither bucket and NO
    // working-tree line rendered. The two likeliest probe failures — the 5s
    // timeout and the 8MB buffer cap — both correlate with a very dirty tree,
    // so the card read clean exactly when the tree was dirtiest.
    const card = renderProposalCard([
      proposal({
        dirtyTreeScoped: [],
        captureErrors: ['git status timed out'],
      }),
    ])

    const line = card.split('\n').find((l) => l.startsWith('*Working tree:*'))
    expect(line).toBeDefined()
    expect(line).not.toMatch(/\bclean\b/i)
    expect(line).toMatch(/capture incomplete/i)
  })

  it('stays silent for a measured empty array with no capture errors', () => {
    const card = renderProposalCard([
      proposal({ dirtyTreeScoped: [], captureErrors: [] }),
    ])

    expect(card).not.toContain('*Working tree:*')
  })

  it('does not let a capture failure hide behind a clean sibling', () => {
    const card = renderProposalCard([
      proposal({ network: 'mainnet' }),
      proposal({
        network: 'arbitrum',
        dirtyTreeScoped: [],
        captureErrors: ['git status timed out'],
      }),
    ])

    const line = card.split('\n').find((l) => l.startsWith('*Working tree:*'))
    expect(line).toMatch(/capture incomplete/i)
    expect(line).toContain('arbitrum')
  })
})

describe('renderProposalCard — the qualifier names the networks it is about', () => {
  it('names the dirty network when another row is only uncaptured', () => {
    // `reported` mixed both buckets, so a card of one dirty and one uncaptured
    // row suppressed the qualifier — and a single path then read as the complete
    // inventory across both networks.
    const card = renderProposalCard([
      proposal({ network: 'mainnet', dirtyTreeScoped: ['src/A.sol'] }),
      proposal({ network: 'arbitrum', dirtyTreeScoped: undefined }),
    ])

    const line = card.split('\n').find((l) => l.startsWith('*Working tree:*'))
    expect(line).toContain('mainnet')
    expect(line).toContain('arbitrum')
    // And the two states must be distinguishable, not merged into one word.
    expect(line).toMatch(/dirty/)
    expect(line).toMatch(/not captured/)
  })
})

describe('renderProposalCard — a truncated list is never vaguer than an exact one', () => {
  it('keeps the count when capture also truncated', () => {
    // 40 paths with no flag rendered "…and 20 more"; the same 40 WITH the flag
    // rendered only "and more that capture stopped counting" — the worse case
    // got the vaguer warning.
    const paths = Array.from({ length: 40 }, (_, i) => `src/F${i}.sol`)
    const exact = renderProposalCard([proposal({ dirtyTreeScoped: paths })])
    const truncated = renderProposalCard([
      proposal({ dirtyTreeScoped: paths, dirtyTreeTruncated: true }),
    ])

    const lineOf = (card: string) =>
      card.split('\n').find((l) => l.startsWith('*Working tree:*')) ?? ''

    expect(lineOf(exact)).toMatch(/20 more/)
    expect(lineOf(truncated)).toMatch(/20 more/)
    expect(lineOf(truncated)).toMatch(/stopped counting/)
  })
})
