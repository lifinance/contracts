/**
 * The deployment commit's `foundry.toml` is written by whoever wrote the
 * record, so every refusal here is a way that file could otherwise have forge
 * run a binary it tracks. Every refusal appends one line to `HONEST`, which
 * the first block shows is accepted, so a test cannot pass because the reader
 * refuses everything.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { readCheckoutProfiles } from './checkout-foundry-config'
import { parseBuildProfiles } from './lineage-scope'

const REPO_TOML = readFileSync(
  join(import.meta.dir, '..', '..', '..', 'foundry.toml'),
  'utf8'
)

const HONEST = `[profile.default]
src = 'src'
solc_version = '0.8.29'
evm_version = 'cancun'
auto_detect_solc = false
`

describe('readCheckoutProfiles accepts what main has carried', () => {
  it("reads this repo's own foundry.toml", () => {
    expect(readCheckoutProfiles(REPO_TOML)).toEqual({
      default: {
        profile: 'default',
        solcVersion: '0.8.29',
        evmVersion: 'cancun',
      },
      solc_floor: {
        profile: 'solc_floor',
        solcVersion: '0.8.17',
        evmVersion: 'london',
      },
      zksync: {
        profile: 'zksync',
        solcVersion: '0.8.29',
        evmVersion: 'cancun',
      },
    })
  })

  it.each([
    ['an inline zksync table', `${HONEST}zksync = { zksolc = '1.5.15' }\n`],
    [
      'a zksync table nested in itself',
      `${HONEST}zksync = { zksync = { zksolc = '1.5.15' } }\n`,
    ],
    [
      'a [profile.zksync.zksync] section',
      `${HONEST}[profile.zksync]\nsolc_version = '0.8.26'\n[profile.zksync.zksync]\nzksolc = '1.5.14'\n`,
    ],
    ['a profile-level zksolc', `${HONEST}zksolc = '1.5.11'\n`],
  ])('accepts %s, as older commits spell the zksolc pin', (_shape, toml) => {
    expect(readCheckoutProfiles(toml).default?.solcVersion).toBe('0.8.29')
  })

  it('returns only profiles that pin both versions', () => {
    const profiles = readCheckoutProfiles(
      `${HONEST}[profile.ci]\n[profile.half]\nsolc_version = '0.8.26'\n`
    )
    expect(Object.keys(profiles)).toEqual(['default'])
  })
})

describe('readCheckoutProfiles refuses a file that could choose the compiler', () => {
  /**
   * The reproduction: a `solc_version` line inside a multi-line string, which
   * forge reads as text, then a `solc` path forge follows.
   */
  const SMUGGLED = `[profile.default]
src = 'src'
evm_version = 'cancun'
auto_detect_solc = false
note = '''
solc_version = '0.8.29'
'''
solc = './fake-solc'
`

  it('refuses the multi-line-string smuggle the line parser accepts', () => {
    expect(parseBuildProfiles(SMUGGLED).default?.solcVersion).toBe('0.8.29')
    expect(() => readCheckoutProfiles(SMUGGLED)).toThrow(
      /profile\.default\.solc is not a key the rebuild allows/
    )
  })

  it.each([
    ['a solc path', "solc = './fake-solc'", /profile\.default\.solc is not/],
    [
      'a zksync.solc_path',
      "zksync = { zksolc = '1.5.15', solc_path = './fake-solc' }",
      /profile\.default\.zksync\.solc_path is not/,
    ],
    [
      'a nested zksync.solc_path',
      "zksync = { zksync = { solc_path = './fake-solc' } }",
      /profile\.default\.zksync\.zksync\.solc_path is not/,
    ],
    [
      'a zksolc path',
      "zksolc = './fake-zksolc'",
      /profile\.default\.zksolc = "\.\/fake-zksolc" is not a plain/,
    ],
    [
      'a zksync.zksolc path',
      "zksync = { zksolc = './fake-zksolc' }",
      /profile\.default\.zksync\.zksolc = "\.\/fake-zksolc" is not a plain/,
    ],
    [
      'a zksync value that is not a table',
      'zksync = true',
      /zksync is not a table/,
    ],
    ['an unknown key', "build_info_path = 'x'", /build_info_path is not a key/],
  ])('refuses %s', (_what, line, pattern) => {
    expect(() => readCheckoutProfiles(`${HONEST}${line}\n`)).toThrow(pattern)
  })

  it('refuses a solc_version that is a path', () => {
    const honest = HONEST
    const pathed = HONEST.replace("'0.8.29'", "'./fake-solc'")
    expect(pathed).not.toBe(honest)
    expect(readCheckoutProfiles(honest).default).toBeDefined()
    expect(() => readCheckoutProfiles(pathed)).toThrow(
      /solc_version = "\.\/fake-solc" is not a plain x\.y\.z version/
    )
  })

  it('refuses a legacy top-level [default] table, which forge still honours', () => {
    expect(() =>
      readCheckoutProfiles(`${HONEST}[default]\nsolc = './fake-solc'\n`)
    ).toThrow(/top-level "default" is not a section/)
  })

  it('refuses a key above every table', () => {
    expect(() =>
      readCheckoutProfiles(`solc = './fake-solc'\n${HONEST}`)
    ).toThrow(/top-level "solc" is not a section/)
  })

  it('refuses a compiler path in any profile, not only the requested one', () => {
    expect(() =>
      readCheckoutProfiles(`${HONEST}[profile.other]\nsolc = './fake-solc'\n`)
    ).toThrow(/profile\.other\.solc is not/)
  })

  it('names every problem, not only the first', () => {
    let message = ''
    try {
      readCheckoutProfiles(`${HONEST}solc = './a'\n[default]\nx = 1\n`)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('profile.default.solc')
    expect(message).toContain('top-level "default"')
  })

  it('refuses a file that is not TOML', () => {
    expect(() =>
      readCheckoutProfiles(`${HONEST}solc_version = '0.8.29'\n`)
    ).toThrow(/not valid TOML/)
  })

  it.each([
    [
      'a profile that is not a table',
      `${HONEST}[profile]\nx = 1\n`,
      /profile\.x is not a table/,
    ],
    [
      'a "profile" that is not a table',
      "profile = 'x'\n",
      /"profile" is not a table/,
    ],
  ])('refuses %s', (_what, toml, pattern) => {
    expect(() => readCheckoutProfiles(toml)).toThrow(pattern)
  })
})

describe('readCheckoutProfiles refuses what forge would merge in as a legacy profile', () => {
  /**
   * The reproduction: forge reads a top-level table as the profile of the same
   * name, so the section's `vyper.path` reaches the profile the rebuild selects.
   */
  const MERGED = `[profile.external]
src = 'src'
solc_version = '0.8.29'
evm_version = 'cancun'
[external]
vyper = { path = './fakevy' }
`

  it('refuses a profile sharing a top-level section name, and the section contents', () => {
    let message = ''
    try {
      readCheckoutProfiles(MERGED)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain(
      'profile.external shares its name with a top-level section'
    )
    expect(message).toContain('external.vyper is not a value')
  })

  it('refuses the collision even when the section holds only what main carries', () => {
    expect(() =>
      readCheckoutProfiles(
        `${HONEST}[profile.lint]\nsolc_version = '0.8.29'\nevm_version = 'cancun'\n[lint]\nlint_on_build = false\n`
      )
    ).toThrow(/profile\.lint shares its name/)
  })

  it.each([
    [
      'lint',
      "[lint]\nlint_on_build = false\nvyper = { path = './fakevy' }\n",
      /lint\.vyper is not/,
    ],
    [
      'lint_on_build as a string',
      "[lint]\nlint_on_build = 'no'\n",
      /lint\.lint_on_build is not/,
    ],
    [
      'external',
      "[external]\nvyper = { path = './fakevy' }\n",
      /external\.vyper is not/,
    ],
    [
      'an external.zksync path',
      "[external.zksync]\nzksolc = '1.5.15'\nsolc_path = './fake-solc'\n",
      /external\.zksync\.solc_path is not/,
    ],
    [
      'an external.zksync.zksolc path',
      "[external.zksync]\nzksolc = './fake-zksolc'\n",
      /external\.zksync\.zksolc = "\.\/fake-zksolc" is not a plain/,
    ],
    [
      'rpc_endpoints',
      "[rpc_endpoints]\nmainnet = 'x'\nvyper = { path = './fakevy' }\n",
      /rpc_endpoints\.vyper is not/,
    ],
    [
      'etherscan',
      "[etherscan]\nmainnet = { key = 'k', url = 'u', path = './fakevy' }\n",
      /etherscan\.mainnet\.path is not/,
    ],
    [
      'an etherscan entry that is a string',
      "[etherscan]\nmainnet = 'k'\n",
      /etherscan\.mainnet is not/,
    ],
  ])(
    'refuses a %s key outside what main has carried',
    (_what, section, pattern) => {
      expect(() => readCheckoutProfiles(`${HONEST}${section}`)).toThrow(pattern)
    }
  )

  it('accepts the sections as main spells them, a numeric chain included', () => {
    const profiles = readCheckoutProfiles(
      `${HONEST}[lint]\nlint_on_build = false\n[external.zksync]\nzksolc = "1.5.15"\nfoundry_zksync = "v0.0.32"\n[rpc_endpoints]\nmainnet = "\${ETH_NODE_URI_MAINNET}"\n[etherscan]\nzksync = { key = "k", url = "u", chain = 324, verifier = "zksync" }\n`
    )
    expect(profiles.default?.solcVersion).toBe('0.8.29')
  })
})
