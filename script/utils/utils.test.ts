/**
 * Unit tests for `script/utils/utils.ts` helpers.
 *
 * For the `foundry.toml` helpers, `readFileSync` is mocked (transparent
 * passthrough unless a test sets `mockedFoundryToml`) so tests control the
 * TOML content instead of being coupled to the repo's live `foundry.toml`.
 * The path-guard tests pin behavior against real `deployments/` files.
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
import { consola } from 'consola'

import type { INetworkInfo } from '../common/types'
import { EnvironmentEnum } from '../common/types'

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

const {
  displayNetworkInfo,
  getContractAddress,
  getFacetSelectors,
  getFoundryDefaultOptimizerRuns,
  node_url,
} = await import('./utils')

type NetworkArg = Parameters<typeof getContractAddress>[0]

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

describe('getContractAddress path guard', () => {
  it('throws on a network name with parent-directory traversal', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is thenable at runtime
    await expect(
      getContractAddress('../../evil' as NetworkArg, 'LiFiDiamond')
    ).rejects.toThrow(/Invalid network name/)
  })

  it('throws on a network name escaping deployments/ into the repo root', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is thenable at runtime
    await expect(
      getContractAddress('../foundry' as NetworkArg, 'LiFiDiamond')
    ).rejects.toThrow(/Invalid network name/)
  })

  it('resolves a real network from the live deployments file', async () => {
    const address = await getContractAddress('mainnet', 'LiFiDiamond')
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })
})

describe('getFacetSelectors path guard', () => {
  it('throws on a facet name with parent-directory traversal', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is thenable at runtime
    await expect(getFacetSelectors('../../evil')).rejects.toThrow(
      /Invalid facet name/
    )
  })

  it('throws on an absolute-path facet name', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is thenable at runtime
    await expect(getFacetSelectors('/etc/passwd')).rejects.toThrow(
      /Invalid facet name/
    )
  })
})

describe('endpoint redaction', () => {
  // A dRPC-shaped endpoint: the provider key rides in the query string, so any print of
  // this string is a live credential.
  const KEYED_URL =
    'https://lb.drpc.org/ogrpc?network=tron&dkey=SYNTHETIC-NOT-REAL-abc123'

  it('keeps the endpoint out of the network info box', () => {
    const realBox = consola.box
    let captured = ''
    consola.box = ((arg: { message: string }) => {
      captured = arg.message
    }) as typeof consola.box

    try {
      displayNetworkInfo(
        { address: '0x0', balance: '0', block: 0 } as unknown as INetworkInfo,
        EnvironmentEnum.production,
        KEYED_URL
      )
    } finally {
      consola.box = realBox
    }

    expect(captured).not.toContain('dkey')
    expect(captured).toContain('[redacted-url]')
    // the mainnet/shasta split reads the raw argument, so redacting the print must not move it
    expect(captured).toContain('Network: Mainnet')
  })

  it('keeps the endpoint out of the unsubstituted-template error', () => {
    const previousUri = process.env.ETH_NODE_URI
    const previousNetworkUri = process.env.ETH_NODE_URI_TESTNET
    delete process.env.ETH_NODE_URI_TESTNET // spawn-env: in-process; the fallback is the case under test
    process.env.ETH_NODE_URI =
      'https://lb.drpc.org/ogrpc?chain={{chain}}&dkey=SYNTHETIC-NOT-REAL-abc123'

    try {
      let message = ''
      try {
        node_url('testnet')
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toContain('[redacted-url]')
      expect(message).not.toContain('dkey')
    } finally {
      if (previousUri !== undefined) process.env.ETH_NODE_URI = previousUri
      else delete process.env.ETH_NODE_URI // spawn-env: in-process restore
      if (previousNetworkUri !== undefined)
        process.env.ETH_NODE_URI_TESTNET = previousNetworkUri
    }
  })
})
