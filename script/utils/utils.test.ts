/**
 * Unit tests for `script/utils/utils.ts` helpers that read `foundry.toml`.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { getFoundryDefaultOptimizerRuns } from './utils'

describe('getFoundryDefaultOptimizerRuns', () => {
  it('returns the optimizer_runs value from [profile.default] in foundry.toml', () => {
    expect(getFoundryDefaultOptimizerRuns()).toBe(1000000)
  })
})
