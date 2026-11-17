import { describe, expect, it } from 'bun:test'

import { redactedError } from './demoScriptHelpers'

const KEYED_RPC =
  'https://base-mainnet.example.io/v2/SECRETKEY123?apikey=SECRET456'

describe('redactedError', () => {
  it('redacts an RPC URL from an Error stack', () => {
    const error = new Error(`HTTP request failed.\nURL: ${KEYED_RPC}`)

    const rendered = redactedError(error)

    expect(rendered).toContain('HTTP request failed.')
    expect(rendered).toContain('[redacted-url]')
    expect(rendered).not.toContain('SECRET')
  })

  it('falls back to the message when an Error has no stack', () => {
    const error = new Error(`request to ${KEYED_RPC} failed`)
    error.stack = undefined

    expect(redactedError(error)).toBe('request to [redacted-url] failed')
  })

  it('redacts a thrown non-Error value', () => {
    expect(redactedError(`timeout calling ${KEYED_RPC}`)).toBe(
      'timeout calling [redacted-url]'
    )
  })
})
