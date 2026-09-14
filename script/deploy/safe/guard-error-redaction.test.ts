// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import { MAX_REASON_LENGTH } from '../../utils/redactUrls'

import {
  guardErrorDetail,
  publishableGuardError,
} from './guard-error-redaction'

const KEYED_RPC = 'https://lb.drpc.org/ogrpc?network=arbitrum&dkey=s3cr3tkey'
const MONGO_URI = 'mongodb+srv://svc:hunter2@cluster0.example.mongodb.net/admin'

/** The layout viem actually produces: shortMessage, then `URL:`, then details. */
const viemError = (): Error =>
  new Error(
    `HTTP request failed.\n\nStatus: 429\nURL: ${KEYED_RPC}\n\nDetails: {"code":-32005,"message":"daily request limit exceeded"}`
  )

const mongoError = (): Error =>
  new Error(`getaddrinfo ENOTFOUND for connection ${MONGO_URI}`)

describe('guardErrorDetail — what the job log gets', () => {
  it('strips the endpoint out of a viem failure', () => {
    const detail = guardErrorDetail(viemError())
    expect(detail).not.toContain('dkey')
    expect(detail).not.toContain('drpc.org')
    expect(detail).toContain('[redacted-url]')
  })

  it('strips the credentials out of a Mongo connection string', () => {
    const detail = guardErrorDetail(mongoError())
    expect(detail).not.toContain('hunter2')
    expect(detail).not.toContain('mongodb.net')
    expect(detail).toContain('[redacted-url]')
  })

  // The Slack cap is wrong here: a stack is what a human debugs the guard from,
  // and 180 chars does not reach the frame that names the failing call.
  it('keeps the stack, uncollapsed and uncapped', () => {
    const error = viemError()
    const detail = guardErrorDetail(error)
    expect(detail.length).toBeGreaterThan(MAX_REASON_LENGTH)
    expect(detail).toContain('\n')
    expect(detail).toContain('daily request limit exceeded')
  })

  it('handles a thrown non-Error', () => {
    expect(guardErrorDetail(`failed against ${KEYED_RPC}`)).toBe(
      'failed against [redacted-url]'
    )
    expect(guardErrorDetail(undefined)).toBe('undefined')
  })
})

describe('publishableGuardError — what Slack gets', () => {
  it('redacts, collapses and caps', () => {
    const published = publishableGuardError(viemError())
    expect(published.message).not.toContain('dkey')
    expect(published.message).not.toContain('drpc.org')
    expect(published.message).toContain('[redacted-url]')
    expect(published.message).not.toContain('\n')
    expect(published.message.length).toBeLessThanOrEqual(
      MAX_REASON_LENGTH + 1 // the ellipsis a truncated reason ends with
    )
  })

  // The notifier reads `.message` off what it is handed and renders it into the
  // Slack block; a bare string takes a different branch of that reader.
  it('returns an Error, so the notifier reads the redacted message', () => {
    const published = publishableGuardError(mongoError())
    expect(published).toBeInstanceOf(Error)
    expect(published.message).not.toContain('hunter2')
  })

  it('handles a thrown non-Error', () => {
    expect(publishableGuardError({ code: 42 }).message).toBe('[object Object]')
  })
})
