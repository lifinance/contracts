/**
 * Pins the factory pilot owner code exported from the troncast types module.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { FACTORY_PILOT_OWNER } from './types'

describe('FACTORY_PILOT_OWNER', () => {
  it('is the factory pilot owner code', () => {
    expect(FACTORY_PILOT_OWNER).toBe('DEINEMUDDA')
  })
})
