import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { nonDateTimestampType, toIsoDate } from './stored-timestamp'

describe('toIsoDate', () => {
  it('formats a Date and epoch ms as ISO strings', () => {
    const iso = '2026-07-06T01:30:00.000Z'
    expect(toIsoDate(new Date(iso))).toBe(iso)
    expect(toIsoDate(Date.parse(iso))).toBe(iso)
  })

  it('returns a stored string unchanged, so the host timezone never applies', () => {
    expect(toIsoDate('2026-07-06T01:30:00')).toBe('2026-07-06T01:30:00')
    expect(toIsoDate('not a date')).toBe('not a date')
  })

  it('never throws on values that are not dates', () => {
    expect(toIsoDate(new Date('nope'))).toBe('Invalid Date')
    expect(toIsoDate(Number.NaN)).toBe('NaN')
    expect(toIsoDate({ toString: 'x' })).toBe('{"toString":"x"}')
    expect(toIsoDate(null)).toBe('null')
    expect(toIsoDate(undefined)).toBe('undefined')
  })

  it('shows the stored shape of an object timestamp', () => {
    expect(toIsoDate({ $date: '2026-07-06T01:30:00Z' })).toBe(
      '{"$date":"2026-07-06T01:30:00Z"}'
    )
  })

  it('falls back to the object tag when the object cannot serialise', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(toIsoDate(cyclic)).toBe('[object Object]')
    expect(toIsoDate({ n: 1n })).toBe('[object Object]')
  })
})

describe('nonDateTimestampType', () => {
  it('returns undefined for a Date, even an invalid one', () => {
    expect(nonDateTimestampType(new Date())).toBeUndefined()
    expect(nonDateTimestampType(new Date('nope'))).toBeUndefined()
  })

  it('names every other stored type', () => {
    expect(nonDateTimestampType('2026-07-06')).toBe('string')
    expect(nonDateTimestampType(0)).toBe('number')
    expect(nonDateTimestampType({})).toBe('object')
    expect(nonDateTimestampType([])).toBe('array')
    expect(nonDateTimestampType(null)).toBe('null')
    expect(nonDateTimestampType(undefined)).toBe('undefined')
  })
})
