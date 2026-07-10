/**
 * Unit tests for `script/utils/utils.ts` helpers that read `foundry.toml`.
 *
 * `readFileSync` is mocked (transparent passthrough unless a test sets
 * `mockedFoundryToml`) so tests control the TOML content instead of being
 * coupled to the repo's live `foundry.toml`.
 */
import * as fs from 'fs'

import {
  afterEach,
  describe,
  expect,
  it,
  mock,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

// Capture the real fs exports BEFORE mock.module replaces the registry entry,
// otherwise the passthrough below would recurse into the mock itself.
const realFs = { ...fs }

let mockedFoundryToml: string | undefined

const patchedReadFileSync = ((
  ...args: Parameters<typeof fs.readFileSync>
): ReturnType<typeof fs.readFileSync> => {
  if (
    mockedFoundryToml !== undefined &&
    String(args[0]).endsWith('foundry.toml')
  )
    return mockedFoundryToml
  return realFs.readFileSync(...args)
}) as typeof fs.readFileSync

mock.module('fs', () => ({
  ...realFs,
  readFileSync: patchedReadFileSync,
  default: { ...realFs, readFileSync: patchedReadFileSync },
}))

const { getFoundryDefaultOptimizerRuns } = await import('./utils')

afterEach(() => {
  mockedFoundryToml = undefined
})

describe('getFoundryDefaultOptimizerRuns', () => {
  it('returns optimizer_runs from [profile.default] via the TOML parser', () => {
    mockedFoundryToml = `
[profile.default]
solc_version = '0.8.17'
evm_version = 'london'
optimizer_runs = 250
`
    expect(getFoundryDefaultOptimizerRuns()).toBe(250)
  })

  it('returns underscore-separated optimizer_runs via the regex fallback', () => {
    // The digit-leading key makes Bun.TOML.parse throw, forcing the regex
    // fallback path that must normalise `1_000_000` to 1000000.
    mockedFoundryToml = `
[profile.default]
optimizer_runs = 1_000_000

[rpc_endpoints]
0g = 'https://example.com'
`
    expect(getFoundryDefaultOptimizerRuns()).toBe(1000000)
  })

  it('throws when optimizer_runs is missing from [profile.default]', () => {
    mockedFoundryToml = `
[profile.default]
solc_version = '0.8.17'
`
    expect(() => getFoundryDefaultOptimizerRuns()).toThrow(
      /Missing or invalid \[profile\.default\]\.optimizer_runs/
    )
  })

  it('throws when optimizer_runs is negative', () => {
    mockedFoundryToml = `
[profile.default]
optimizer_runs = -1
`
    expect(() => getFoundryDefaultOptimizerRuns()).toThrow(
      /Missing or invalid \[profile\.default\]\.optimizer_runs/
    )
  })

  it('throws when optimizer_runs is not an integer', () => {
    mockedFoundryToml = `
[profile.default]
optimizer_runs = 1.5
`
    expect(() => getFoundryDefaultOptimizerRuns()).toThrow(
      /Missing or invalid \[profile\.default\]\.optimizer_runs/
    )
  })

  it('throws when [profile.default] is missing entirely', () => {
    mockedFoundryToml = `
[profile.other]
optimizer_runs = 200
`
    expect(() => getFoundryDefaultOptimizerRuns()).toThrow(
      /Failed to determine optimizer runs from foundry\.toml/
    )
  })

  it('reads a valid value from the repo foundry.toml (integration sanity)', () => {
    const value = getFoundryDefaultOptimizerRuns()
    expect(Number.isSafeInteger(value)).toBe(true)
    expect(value).toBeGreaterThanOrEqual(0)
  })
})
