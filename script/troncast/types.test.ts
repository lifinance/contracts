// eslint-disable-next-line import/no-unresolved
import { describe, it, expect } from 'bun:test'

import { FACTORY_INTAKE_PROBE } from './types'

describe('FACTORY_INTAKE_PROBE', () => {
  it('equals the intake probe code', () => {
    expect(FACTORY_INTAKE_PROBE).toBe('IP-1006-QX')
  })
})
