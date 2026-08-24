/**
 * Every consumer of this module publishes to Slack, so the marker it leaves behind has to be
 * safe there as well as free of the endpoint it replaced.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { MAX_REASON_LENGTH, redactErrorReason, redactUrls } from './redactUrls'

describe('redactUrls', () => {
  it('replaces an endpoint with a marker Slack will not reinterpret', () => {
    const redacted = redactUrls(
      'URL: https://lb.example.org/ogrpc?network=base&dkey=DUMMY-TEST-VALUE'
    )
    expect(redacted).not.toContain('DUMMY-TEST-VALUE')
    expect(redacted).not.toContain('lb.example.org')
    expect(redacted).toBe('URL: [redacted-url]')
    // Slack parses <...> as a link element, so the marker must not use angle brackets.
    expect(redacted).not.toContain('<')
    expect(redacted).not.toContain('>')
  })

  it('replaces every endpoint in the text, not just the first', () => {
    const redacted = redactUrls(
      'a https://x.example.org/1 b https://y.example.org/2 c'
    )
    expect(redacted).toBe('a [redacted-url] b [redacted-url] c')
  })

  it('matches any scheme, not only http', () => {
    expect(
      redactUrls('mongodb+srv://someuser:somepass@cluster.example.net/db')
    ).toBe('[redacted-url]')
    expect(redactUrls('ws://node.example.org:8546')).toBe('[redacted-url]')
  })

  it('leaves text without an endpoint untouched, including whitespace', () => {
    const plain = 'Facet LiFiIntentEscrowFacetV2 not registered\n  in Diamond'
    expect(redactUrls(plain)).toBe(plain)
  })
})

describe('redactErrorReason', () => {
  it('redacts, collapses to one line, and keeps the useful part', () => {
    const reason = redactErrorReason(
      'HTTP request failed.\n\nURL: https://lb.example.org/?k=DUMMY-TEST-VALUE\n'
    )
    expect(reason).toBe('HTTP request failed. URL: [redacted-url]')
  })

  it('caps the length so one message cannot flood an alert line', () => {
    const reason = redactErrorReason('x'.repeat(MAX_REASON_LENGTH + 50))
    expect(reason).toHaveLength(MAX_REASON_LENGTH + 1)
    expect(reason.endsWith('…')).toBe(true)
  })

  it('redacts before capping, so a long endpoint cannot survive truncation', () => {
    const reason = redactErrorReason(
      `${'x'.repeat(
        MAX_REASON_LENGTH
      )} https://lb.example.org/?k=DUMMY-TEST-VALUE`
    )
    expect(reason).not.toContain('DUMMY-TEST-VALUE')
  })
})
