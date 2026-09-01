import {
  afterEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  MISSING_TICKET_MESSAGE,
  assertTicketPresent,
  formatReasonWarning,
  parseTicketLink,
  resolveProposalIntent,
  summarizeReasonAdoption,
} from './proposal-intent'

describe('parseTicketLink', () => {
  it('accepts a canonical Linear issue URL and keeps it verbatim', () => {
    const url = 'https://linear.app/lifi-linear/issue/EXSC-694/one-line-reason'
    expect(parseTicketLink(url)).toEqual({ ok: true, url })
  })

  it('accepts an issue URL without the trailing slug', () => {
    const url = 'https://linear.app/lifi-linear/issue/EXSC-694'
    expect(parseTicketLink(url)).toEqual({ ok: true, url })
  })

  it('normalizes a bare ticket id into a URL', () => {
    // Operators type the id; refusing it would push everyone to paste a URL for
    // a value that is fully determined by the id.
    expect(parseTicketLink('EXSC-694')).toEqual({
      ok: true,
      url: 'https://linear.app/lifi-linear/issue/EXSC-694',
    })
  })

  it('trims surrounding whitespace before deciding', () => {
    expect(parseTicketLink('  EXSC-694\n')).toEqual({
      ok: true,
      url: 'https://linear.app/lifi-linear/issue/EXSC-694',
    })
  })

  it('stores the parsed URL, so control characters inside it do not survive', () => {
    // URL parsing tolerates a mid-string newline by dropping it; the stored
    // value must not be the raw input that still carries one.
    expect(parseTicketLink('https://linear.app/iss\nue/EXSC-694')).toEqual({
      ok: true,
      url: 'https://linear.app/issue/EXSC-694',
    })
  })

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('reports %s as absent rather than invalid', (_label, raw) => {
    const result = parseTicketLink(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('absent')
  })

  it.each([
    // The whole point of validating the shape: none of these is a ticket link,
    // and accepting any of them makes the block decorative.
    ['a non-Linear host', 'https://example.com/issue/EXSC-694'],
    ['a Linear look-alike host', 'https://linear.app.evil.com/issue/EXSC-694'],
    [
      'a Linear URL that is not an issue',
      'https://linear.app/lifi-linear/project/foo',
    ],
    // A well-formed id under the WRONG path segment: the only input that
    // isolates the '/issue/' check from the id check, since every other
    // non-issue URL is also caught by the id pattern.
    [
      'a well-formed id outside /issue/',
      'https://linear.app/lifi-linear/project/EXSC-694',
    ],
    // A valid id as the FIRST path segment: the only input that isolates the
    // '/issue/' requirement, since dropping it falls back to segment 0.
    ['an id directly under the host', 'https://linear.app/EXSC-694'],
    // Hosts that CONTAIN the real one. A substring test accepts all three.
    [
      'a host containing the real one',
      'https://evil-linear.app.co/issue/EXSC-694',
    ],
    // Ends with the real host, so a suffix test accepts it.
    ['a host ending in the real one', 'https://evil-linear.app/issue/EXSC-694'],
    [
      'the real host as a subdomain',
      'https://linear.app.evil.com/issue/EXSC-694',
    ],
    [
      'the real host as a path prefix',
      'https://evil.com/linear.app/issue/EXSC-694',
    ],
    [
      'a malformed id in the path',
      'https://linear.app/lifi-linear/issue/not-a-ticket',
    ],
    // These parse with hostname `linear.app`, so the host check passes them and
    // only the scheme check stands between them and the stored field.
    ['a javascript: URL', 'javascript://linear.app/issue/EXSC-694/%0Aalert(1)'],
    ['a data: URL', 'data://linear.app/issue/EXSC-694'],
    ['a file: URL', 'file://linear.app/issue/EXSC-694'],
    ['a non-web scheme', 'ftp://linear.app/issue/EXSC-694'],
    // Scheme, host, path and id all pass on these two, so only the userinfo
    // check can reject them.
    [
      'a link carrying a password',
      'https://user:secret@linear.app/issue/EXSC-694',
    ],
    ['a link carrying a username', 'https://token@linear.app/issue/EXSC-694'],
    ['a lowercase bare id', 'exsc-694'],
    ['a bare id with no number', 'EXSC-'],
    ['a bare id with no team', '-694'],
    ['prose that merely mentions a ticket', 'see EXSC-694 for details'],
    ['a plain word', 'later'],
  ])('rejects %s', (_label, raw) => {
    const result = parseTicketLink(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('invalid')
  })
})

describe('resolveProposalIntent', () => {
  it('refuses to resolve without a ticket, naming both channels', () => {
    expect(() => resolveProposalIntent({})).toThrow(MISSING_TICKET_MESSAGE)
    // The refusal has to tell the operator how to comply, or the hard block is
    // just an outage.
    expect(MISSING_TICKET_MESSAGE).toContain('--ticket')
    expect(MISSING_TICKET_MESSAGE).toContain('SAFE_PROPOSAL_TICKET')
  })

  it('refuses an invalid ticket rather than storing it as "a link"', () => {
    expect(() =>
      resolveProposalIntent({ ticket: 'https://example.com/EXSC-694' })
    ).toThrow(/not a Linear issue link/)
  })

  it('prefers the explicit flag over the environment', () => {
    expect(
      resolveProposalIntent({
        ticket: 'EXSC-111',
        envTicket: 'EXSC-222',
      }).ticketUrl
    ).toBe('https://linear.app/lifi-linear/issue/EXSC-111')
  })

  it('falls back to the environment so bash flows need no new argument', () => {
    expect(resolveProposalIntent({ envTicket: 'EXSC-222' }).ticketUrl).toBe(
      'https://linear.app/lifi-linear/issue/EXSC-222'
    )
  })

  it('returns the reason when supplied and reports no warning', () => {
    const intent = resolveProposalIntent({
      ticket: 'EXSC-694',
      reason: 'rotate the pauser key',
    })
    expect(intent.reason).toBe('rotate the pauser key')
    expect(intent.reasonMissing).toBe(false)
  })

  it('flags a missing reason without blocking, per OQ3', () => {
    // OQ3: the reason is optional-with-warning; only the ticket blocks.
    const intent = resolveProposalIntent({ ticket: 'EXSC-694' })
    expect(intent.reason).toBeUndefined()
    expect(intent.reasonMissing).toBe(true)
  })

  it('treats a whitespace-only reason as missing, not as a reason', () => {
    expect(
      resolveProposalIntent({ ticket: 'EXSC-694', reason: '   ' }).reasonMissing
    ).toBe(true)
  })

  it('prefers an explicit reason over the environment', () => {
    expect(
      resolveProposalIntent({
        ticket: 'EXSC-694',
        reason: 'from the flag',
        envReason: 'from the environment',
      }).reason
    ).toBe('from the flag')
  })

  it('falls back to the environment for the reason too', () => {
    expect(
      resolveProposalIntent({
        ticket: 'EXSC-694',
        envReason: 'from the environment',
      }).reason
    ).toBe('from the environment')
  })
})

describe('formatReasonWarning', () => {
  it('names the ticket and both channels so the fix is obvious', () => {
    const warning = formatReasonWarning(
      'https://linear.app/lifi-linear/issue/EXSC-694'
    )
    expect(warning).toContain('EXSC-694')
    expect(warning).toContain('--reason')
    expect(warning).toContain('SAFE_PROPOSAL_REASON')
  })
})

describe('summarizeReasonAdoption', () => {
  const withReason = { reason: 'why' }
  const without = {}

  it('reports the flip trigger as met after 30 consecutive proposals with a reason', () => {
    const summary = summarizeReasonAdoption(Array(30).fill(withReason))

    expect(summary.examined).toBe(30)
    expect(summary.reasonless).toBe(0)
    expect(summary.consecutiveWithReason).toBe(30)
    expect(summary.flipReady).toBe(true)
  })

  it('does not report the trigger met on 29', () => {
    const summary = summarizeReasonAdoption(Array(29).fill(withReason))

    expect(summary.consecutiveWithReason).toBe(29)
    expect(summary.flipReady).toBe(false)
  })

  it('counts the streak from the newest proposal backwards', () => {
    // Newest first, as the query returns them. A reasonless proposal 30 back
    // must not veto a streak that has since been clean.
    const summary = summarizeReasonAdoption([
      ...Array(30).fill(withReason),
      without,
    ])

    expect(summary.reasonless).toBe(1)
    expect(summary.consecutiveWithReason).toBe(30)
    expect(summary.flipReady).toBe(true)
  })

  it('resets the streak at the newest reasonless proposal', () => {
    const summary = summarizeReasonAdoption([
      without,
      ...Array(40).fill(withReason),
    ])

    expect(summary.consecutiveWithReason).toBe(0)
    expect(summary.flipReady).toBe(false)
  })

  it('treats a whitespace-only reason as no reason', () => {
    // Otherwise `--reason " "` satisfies the trigger while telling the signer
    // nothing, and the flip lands on a fake adoption number.
    const summary = summarizeReasonAdoption([
      { reason: '   ' },
      ...Array(30).fill(withReason),
    ])

    expect(summary.consecutiveWithReason).toBe(0)
    expect(summary.flipReady).toBe(false)
  })

  it('measures the streak from the NEWEST gap, not the oldest', () => {
    // Two gaps at different depths. Reading the oldest one instead would report
    // a 32-long streak and declare the flip ready off one recent reasoned
    // proposal — the single fixture shape that separates the two readings.
    const summary = summarizeReasonAdoption([
      withReason,
      without,
      ...Array(30).fill(withReason),
      without,
    ])

    expect(summary.reasonless).toBe(2)
    expect(summary.consecutiveWithReason).toBe(1)
    expect(summary.flipReady).toBe(false)
  })

  it('never claims the trigger is met on an empty collection', () => {
    const summary = summarizeReasonAdoption([])

    expect(summary.examined).toBe(0)
    expect(summary.flipReady).toBe(false)
  })
})

describe('assertTicketPresent', () => {
  const originalTicket = process.env.SAFE_PROPOSAL_TICKET

  afterEach(() => {
    if (originalTicket === undefined) delete process.env.SAFE_PROPOSAL_TICKET
    else process.env.SAFE_PROPOSAL_TICKET = originalTicket
  })

  it('refuses with no ticket in the environment', () => {
    delete process.env.SAFE_PROPOSAL_TICKET

    expect(() => assertTicketPresent()).toThrow(/SAFE_PROPOSAL_TICKET/)
  })

  it('refuses a malformed ticket', () => {
    process.env.SAFE_PROPOSAL_TICKET = 'https://example.com/issue/EXSC-1'

    expect(() => assertTicketPresent()).toThrow(/not a Linear issue link/)
  })

  it('returns the canonical URL when one is set', () => {
    process.env.SAFE_PROPOSAL_TICKET = 'EXSC-694'

    expect(assertTicketPresent()).toBe(
      'https://linear.app/lifi-linear/issue/EXSC-694'
    )
  })

  it('prefers an explicit ticket over the environment', () => {
    process.env.SAFE_PROPOSAL_TICKET = 'EXSC-222'

    expect(assertTicketPresent('EXSC-111')).toBe(
      'https://linear.app/lifi-linear/issue/EXSC-111'
    )
  })
})

describe('parseTicketLink — credential leakage', () => {
  it('refuses a credential-bearing link without echoing the credential', () => {
    const result = parseTicketLink(
      'https://user:hunter2@linear.app/issue/EXSC-694'
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).not.toContain('hunter2')
  })
})
