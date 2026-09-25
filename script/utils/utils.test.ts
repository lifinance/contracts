/**
 * Unit tests for `script/utils/utils.ts` helpers.
 *
 * For the `foundry.toml` helpers, `readFileSync` is mocked (transparent
 * passthrough unless a test sets `mockedFoundryToml`) so tests control the
 * TOML content instead of being coupled to the repo's live `foundry.toml`.
 * The path-guard tests pin behavior against real `deployments/` files.
 */
import * as fs from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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
  getFacetAddressFromDiamondLog,
  getFacetSelectors,
  getFoundryDefaultOptimizerRuns,
  node_url,
  saveContractAddress,
  saveDiamondDeployment,
  updateDiamondJson,
  updateDiamondJsonBatch,
  updateDiamondJsonPeriphery,
} = await import('./utils')

type NetworkArg = Parameters<typeof getContractAddress>[0]

/** Per [CONV:TEST-ASSERT-REJECTS] — `expect().rejects` is not a real Promise. */
async function expectRejects(
  promise: Promise<unknown>,
  match: RegExp | string
): Promise<void> {
  let error: Error | undefined
  try {
    await promise
  } catch (caught) {
    error = caught as Error
  }
  expect(error).toBeInstanceOf(Error)
  if (match instanceof RegExp) expect(error?.message).toMatch(match)
  else expect(error?.message).toContain(match)
}

afterEach(() => {
  mockedFoundryToml = undefined
})

describe('getFoundryDefaultOptimizerRuns', () => {
  it('returns optimizer_runs from [profile.default]', () => {
    mockedFoundryToml = `
[profile.default]
solc_version = '0.8.17'
evm_version = 'london'
optimizer_runs = 250
`
    expect(getFoundryDefaultOptimizerRuns()).toBe(250)
  })

  it('normalises underscore-separated optimizer_runs and ignores later sections', () => {
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

  it('throws when optimizer_runs has trailing junk', () => {
    mockedFoundryToml = `
[profile.default]
optimizer_runs = 200abc
`
    expect(() => getFoundryDefaultOptimizerRuns()).toThrow(
      /Missing or invalid \[profile\.default\]\.optimizer_runs/
    )
  })

  it('reads optimizer_runs followed by a comment', () => {
    mockedFoundryToml = `
[profile.default]
optimizer_runs = 200 # tuned for size
`
    expect(getFoundryDefaultOptimizerRuns()).toBe(200)
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
    await expectRejects(
      getContractAddress('../../evil' as NetworkArg, 'LiFiDiamond'),
      /Invalid network name/
    )
  })

  it('throws on a network name escaping deployments/ into the repo root', async () => {
    await expectRejects(
      getContractAddress('../foundry' as NetworkArg, 'LiFiDiamond'),
      /Invalid network name/
    )
  })

  it('resolves a real network from the live deployments file', async () => {
    const address = await getContractAddress('mainnet', 'LiFiDiamond')
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })
})

describe('getFacetSelectors path guard', () => {
  it('throws on a facet name with parent-directory traversal', async () => {
    await expectRejects(getFacetSelectors('../../evil'), /Invalid facet name/)
  })

  it('throws on an absolute-path facet name', async () => {
    await expectRejects(getFacetSelectors('/etc/passwd'), /Invalid facet name/)
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
    delete process.env.ETH_NODE_URI_TESTNET // spawn-env: in-process; set, node_url returns early and the assertion never runs
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
      else {
        delete process.env.ETH_NODE_URI // spawn-env: in-process restore
      }
      if (previousNetworkUri !== undefined)
        process.env.ETH_NODE_URI_TESTNET = previousNetworkUri
    }
  })
})

describe('getFacetAddressFromDiamondLog', () => {
  const LOG = JSON.stringify({
    LiFiDiamond: {
      Facets: {
        TG6586TTEv664XWSD875tMk6yDuwedphpW: {
          Name: 'EcoFacet',
          Version: '1.1.0',
        },
        TR15epdwXG9kBXtEBnF5bv6kSYRY5w6mXY: {
          Name: 'AllBridgeFacet',
          Version: '2.2.0',
        },
      },
    },
  })

  /** Runs `assertions` from a throwaway repo root holding (or missing) a diamond log. */
  const withDiamondLog = async (
    contents: string | undefined,
    assertions: () => Promise<void>
  ) => {
    const root = realFs.mkdtempSync(join(tmpdir(), 'diamond-log-'))
    const previousCwd = process.cwd()
    try {
      realFs.mkdirSync(join(root, 'deployments'))
      if (contents !== undefined)
        realFs.writeFileSync(
          join(root, 'deployments', 'tron.diamond.json'),
          contents
        )
      process.chdir(root)
      await assertions()
    } finally {
      process.chdir(previousCwd)
      realFs.rmSync(root, { recursive: true, force: true })
    }
  }

  it('resolves the recorded address by facet name', async () => {
    await withDiamondLog(LOG, async () => {
      expect(await getFacetAddressFromDiamondLog('tron', 'EcoFacet')).toBe(
        'TG6586TTEv664XWSD875tMk6yDuwedphpW'
      )
    })
  })

  // Every miss has to read as "first registration" — never as a wrong removal target.
  it('returns null for a facet the log does not carry', async () => {
    await withDiamondLog(LOG, async () => {
      expect(
        await getFacetAddressFromDiamondLog('tron', 'MayanFacet')
      ).toBeNull()
    })
  })

  it('returns null when the log is absent', async () => {
    await withDiamondLog(undefined, async () => {
      expect(await getFacetAddressFromDiamondLog('tron', 'EcoFacet')).toBeNull()
    })
  })

  // Reading a corrupt log as "absent" would plan a first-registration cut, which
  // drops the Remove entries whenever the new selectors miss the old ones
  // entirely — the exact failure the upgrade planner exists to prevent.
  it('throws when the log exists but cannot be parsed', async () => {
    await withDiamondLog('{ not json', async () => {
      await expectRejects(
        getFacetAddressFromDiamondLog('tron', 'EcoFacet'),
        /No readable tron\.diamond\.json .*tron\.diamond\.json \(/
      )
    })
  })

  // Same reasoning one step further in: a log that parses but carries no facet
  // section is not a log that records nothing.
  it('throws when the log has no LiFiDiamond.Facets section', async () => {
    await withDiamondLog(JSON.stringify({ LiFiDiamond: {} }), async () => {
      await expectRejects(
        getFacetAddressFromDiamondLog('tron', 'EcoFacet'),
        /no LiFiDiamond\.Facets object/
      )
    })
  })

  // `typeof [] === 'object'`, so a list shape clears the object check and then
  // yields no entries — "nothing recorded" again, by a different route.
  it('throws when the facet section is an array', async () => {
    await withDiamondLog(
      JSON.stringify({ LiFiDiamond: { Facets: [] } }),
      async () => {
        await expectRejects(
          getFacetAddressFromDiamondLog('tron', 'EcoFacet'),
          /no LiFiDiamond\.Facets object/
        )
      }
    )
  })

  it('accepts a log whose facet section is genuinely empty', async () => {
    await withDiamondLog(
      JSON.stringify({ LiFiDiamond: { Facets: {} } }),
      async () => {
        expect(
          await getFacetAddressFromDiamondLog('tron', 'EcoFacet')
        ).toBeNull()
      }
    )
  })

  // The deployment roots include the parent workspace, so a file that is not a
  // diamond log can sit in front of the checkout that owns one. Refusing there
  // would let an unrelated repo block every Tron upgrade proposal.
  it('reads past a root whose file is not a diamond log', async () => {
    const root = realFs.mkdtempSync(join(tmpdir(), 'diamond-log-'))
    const previousCwd = process.cwd()
    try {
      realFs.mkdirSync(join(root, 'deployments'), { recursive: true })
      realFs.writeFileSync(
        join(root, 'deployments', 'tron.diamond.json'),
        JSON.stringify({})
      )
      realFs.mkdirSync(join(root, 'contracts', 'deployments'), {
        recursive: true,
      })
      realFs.writeFileSync(
        join(root, 'contracts', 'deployments', 'tron.diamond.json'),
        LOG
      )
      process.chdir(root)

      expect(await getFacetAddressFromDiamondLog('tron', 'EcoFacet')).toBe(
        'TG6586TTEv664XWSD875tMk6yDuwedphpW'
      )
    } finally {
      process.chdir(previousCwd)
      realFs.rmSync(root, { recursive: true, force: true })
    }
  })

  // A well-formed log is the answer for its network, so a facet it does not
  // carry is a first registration — not a cue to go looking in a sibling
  // checkout, whose entry would name a facet this diamond never routed.
  it('does not consult a later root once a log answers', async () => {
    const root = realFs.mkdtempSync(join(tmpdir(), 'diamond-log-'))
    const previousCwd = process.cwd()
    try {
      realFs.mkdirSync(join(root, 'deployments'), { recursive: true })
      realFs.writeFileSync(join(root, 'deployments', 'tron.diamond.json'), LOG)
      realFs.mkdirSync(join(root, 'contracts', 'deployments'), {
        recursive: true,
      })
      realFs.writeFileSync(
        join(root, 'contracts', 'deployments', 'tron.diamond.json'),
        JSON.stringify({
          LiFiDiamond: {
            Facets: {
              TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb: { Name: 'MayanFacet' },
            },
          },
        })
      )
      process.chdir(root)

      expect(
        await getFacetAddressFromDiamondLog('tron', 'MayanFacet')
      ).toBeNull()
    } finally {
      process.chdir(previousCwd)
      realFs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('propagates a read failure that is not a missing file', async () => {
    const root = realFs.mkdtempSync(join(tmpdir(), 'diamond-log-'))
    const previousCwd = process.cwd()
    try {
      // A directory where the log belongs: readFile fails with EISDIR, not ENOENT.
      realFs.mkdirSync(join(root, 'deployments', 'tron.diamond.json'), {
        recursive: true,
      })
      process.chdir(root)
      await expectRejects(
        getFacetAddressFromDiamondLog('tron', 'EcoFacet'),
        /EISDIR|illegal operation on a directory/i
      )
    } finally {
      process.chdir(previousCwd)
      realFs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('saveContractAddress', () => {
  /**
   * Runs `assertions` from `<base>/ws`, so every deployment root the helper
   * considers (`ws`, `ws/contracts`, `base`) is a throwaway directory.
   */
  const withWorkspace = async (
    assertions: (workspace: string) => Promise<void>
  ) => {
    const base = realFs.mkdtempSync(join(tmpdir(), 'save-address-'))
    const workspace = join(base, 'ws')
    realFs.mkdirSync(workspace)
    const previousCwd = process.cwd()
    const previousProduction = process.env.PRODUCTION
    try {
      process.env.PRODUCTION = 'false'
      process.chdir(workspace)
      await assertions(workspace)
    } finally {
      process.chdir(previousCwd)
      if (previousProduction === undefined) {
        delete process.env.PRODUCTION
      } else {
        process.env.PRODUCTION = previousProduction
      }
      realFs.rmSync(base, { recursive: true, force: true })
    }
  }

  const readLog = (workspace: string): unknown =>
    JSON.parse(
      realFs.readFileSync(
        join(workspace, 'deployments', 'tron.staging.json'),
        'utf8'
      )
    )

  it('creates deployments/ when no deployment root has one', async () => {
    await withWorkspace(async (workspace) => {
      await saveContractAddress('tron', 'EcoFacet', 'TAddr1')

      expect(readLog(workspace)).toEqual({ EcoFacet: 'TAddr1' })
    })
  })

  it('keeps the addresses already recorded', async () => {
    await withWorkspace(async (workspace) => {
      realFs.mkdirSync(join(workspace, 'deployments'))
      realFs.writeFileSync(
        join(workspace, 'deployments', 'tron.staging.json'),
        JSON.stringify({ AllBridgeFacet: 'TAddr0' })
      )

      await saveContractAddress('tron', 'EcoFacet', 'TAddr1')

      expect(readLog(workspace)).toEqual({
        AllBridgeFacet: 'TAddr0',
        EcoFacet: 'TAddr1',
      })
    })
  })

  // Starting fresh here would rewrite the file with one entry and drop every
  // other address it recorded.
  it('refuses to rewrite a log it cannot parse', async () => {
    await withWorkspace(async (workspace) => {
      const logPath = join(workspace, 'deployments', 'tron.staging.json')
      const corrupt = '{\n<<<<<<< HEAD\n  "AllBridgeFacet": "TAddr0"\n'
      realFs.mkdirSync(join(workspace, 'deployments'))
      realFs.writeFileSync(logPath, corrupt)

      await expectRejects(
        saveContractAddress('tron', 'EcoFacet', 'TAddr1'),
        /Cannot parse .*tron\.staging\.json; fix it, then record EcoFacet at TAddr1/
      )
      expect(realFs.readFileSync(logPath, 'utf8')).toBe(corrupt)
    })
  })

  // A root is chosen by its `deployments/` directory when no root holds the
  // file yet, so a parent-workspace cwd writes where getContractAddress reads.
  it('writes into the root that already has deployments/', async () => {
    await withWorkspace(async (workspace) => {
      const base = join(workspace, '..')
      realFs.mkdirSync(join(base, 'deployments'))

      await saveContractAddress('tron', 'EcoFacet', 'TAddr1')

      expect(realFs.existsSync(join(workspace, 'deployments'))).toBe(false)
      expect(
        JSON.parse(
          realFs.readFileSync(
            join(base, 'deployments', 'tron.staging.json'),
            'utf8'
          )
        )
      ).toEqual({ EcoFacet: 'TAddr1' })
    })
  })
})

describe('diamond log writers', () => {
  /** Runs `assertions` from a throwaway cwd, with or without `deployments/`. */
  const withCwd = async (
    withDeploymentsDir: boolean,
    assertions: (logPath: string) => Promise<void>
  ) => {
    const root = realFs.mkdtempSync(join(tmpdir(), 'diamond-writers-'))
    const previousCwd = process.cwd()
    const previousProduction = process.env.PRODUCTION
    try {
      process.env.PRODUCTION = 'true'
      if (withDeploymentsDir) realFs.mkdirSync(join(root, 'deployments'))
      process.chdir(root)
      await assertions(join(root, 'deployments', 'tron.diamond.json'))
    } finally {
      process.chdir(previousCwd)
      if (previousProduction === undefined) {
        delete process.env.PRODUCTION
      } else {
        process.env.PRODUCTION = previousProduction
      }
      realFs.rmSync(root, { recursive: true, force: true })
    }
  }

  const readLog = (logPath: string): unknown =>
    JSON.parse(realFs.readFileSync(logPath, 'utf8'))

  /** Runs `action` with consola.error captured, since the writers log and do not throw. */
  const captureErrors = async (action: () => Promise<void>) => {
    const realError = consola.error
    const messages: string[] = []
    consola.error = ((...args: unknown[]) => {
      messages.push(args.map(String).join(' '))
    }) as typeof consola.error
    try {
      await action()
    } finally {
      consola.error = realError
    }
    return messages
  }

  it('saveDiamondDeployment creates deployments/ when it is missing', async () => {
    await withCwd(false, async (logPath) => {
      await saveDiamondDeployment('tron', 'TDiamond', {
        EcoFacet: { address: 'TAddr1', version: '1.0.0' },
      })

      expect(readLog(logPath)).toEqual({
        LiFiDiamond: {
          Facets: { TAddr1: { Name: 'EcoFacet', Version: '1.0.0' } },
          Periphery: {},
        },
      })
    })
  })

  it('updateDiamondJson creates deployments/ when it is missing', async () => {
    await withCwd(false, async (logPath) => {
      const errors = await captureErrors(() =>
        updateDiamondJson('TAddr1', 'EcoFacet', '1.0.0')
      )

      expect(errors).toEqual([])
      expect(readLog(logPath)).toEqual({
        LiFiDiamond: {
          Facets: { TAddr1: { Name: 'EcoFacet', Version: '1.0.0' } },
          Periphery: {},
        },
      })
    })
  })

  it('updateDiamondJson replaces a facet by name and keeps the rest', async () => {
    await withCwd(true, async (logPath) => {
      realFs.writeFileSync(
        logPath,
        JSON.stringify({
          LiFiDiamond: {
            Facets: {
              TOld: { Name: 'EcoFacet', Version: '0.9.0' },
              TOther: { Name: 'AllBridgeFacet', Version: '2.2.0' },
            },
            Periphery: { Executor: 'TExec' },
          },
        })
      )

      await updateDiamondJson('TNew', 'EcoFacet', '1.0.0')

      expect(readLog(logPath)).toEqual({
        LiFiDiamond: {
          Facets: {
            TOther: { Name: 'AllBridgeFacet', Version: '2.2.0' },
            TNew: { Name: 'EcoFacet', Version: '1.0.0' },
          },
          Periphery: { Executor: 'TExec' },
        },
      })
    })
  })

  it('updateDiamondJsonBatch adds every entry in one write', async () => {
    await withCwd(true, async (logPath) => {
      await updateDiamondJsonBatch([
        { address: 'TAddr1', name: 'EcoFacet', version: '1.0.0' },
        { address: 'TAddr2', name: 'AllBridgeFacet', version: '2.2.0' },
      ])

      expect(readLog(logPath)).toEqual({
        LiFiDiamond: {
          Facets: {
            TAddr1: { Name: 'EcoFacet', Version: '1.0.0' },
            TAddr2: { Name: 'AllBridgeFacet', Version: '2.2.0' },
          },
          Periphery: {},
        },
      })
    })
  })

  it('updateDiamondJsonPeriphery records the contract and keeps the facets', async () => {
    await withCwd(true, async (logPath) => {
      realFs.writeFileSync(
        logPath,
        JSON.stringify({
          LiFiDiamond: {
            Facets: { TAddr1: { Name: 'EcoFacet', Version: '1.0.0' } },
          },
        })
      )

      await updateDiamondJsonPeriphery('TExec', 'Executor')

      expect(readLog(logPath)).toEqual({
        LiFiDiamond: {
          Facets: { TAddr1: { Name: 'EcoFacet', Version: '1.0.0' } },
          Periphery: { Executor: 'TExec' },
        },
      })
    })
  })

  // Starting fresh here would rewrite the log with one entry and drop every
  // other facet and periphery contract it recorded.
  it.each([
    [
      'updateDiamondJson',
      () => updateDiamondJson('TAddr1', 'EcoFacet', '1.0.0'),
      /record EcoFacet at TAddr1 by hand/,
    ],
    [
      'updateDiamondJsonBatch',
      () =>
        updateDiamondJsonBatch([
          { address: 'TAddr1', name: 'EcoFacet', version: '1.0.0' },
          { address: 'TAddr2', name: 'AllBridgeFacet', version: '2.2.0' },
        ]),
      /record EcoFacet, AllBridgeFacet by hand/,
    ],
    [
      'updateDiamondJsonPeriphery',
      () => updateDiamondJsonPeriphery('TExec', 'Executor'),
      /record Executor at TExec by hand/,
    ],
  ] as Array<[string, () => Promise<void>, RegExp]>)(
    '%s leaves a log it cannot parse untouched',
    async (_name, write, recovery) => {
      await withCwd(true, async (logPath) => {
        const corrupt = '{\n<<<<<<< HEAD\n  "LiFiDiamond": {}\n'
        realFs.writeFileSync(logPath, corrupt)

        const errors = await captureErrors(write)

        expect(realFs.readFileSync(logPath, 'utf8')).toBe(corrupt)
        expect(errors.join('\n')).toMatch(/Cannot parse .*tron\.diamond\.json/)
        expect(errors.join('\n')).toMatch(recovery)
      })
    }
  )
})

// An array or null parses, so only a shape check stops the writer: the entry
// it adds to an array is a string key that JSON.stringify drops.
describe('deployment-log writers refuse a log of the wrong shape', () => {
  /** Runs `write` from a throwaway cwd whose log at `name` holds `contents`. */
  const withLog = async (
    name: string,
    contents: string,
    write: () => Promise<void>
  ) => {
    const root = realFs.mkdtempSync(join(tmpdir(), 'log-shape-'))
    const previousCwd = process.cwd()
    const previousProduction = process.env.PRODUCTION
    const realError = consola.error
    const errors: string[] = []
    try {
      process.env.PRODUCTION = 'true'
      realFs.mkdirSync(join(root, 'deployments'))
      realFs.writeFileSync(join(root, 'deployments', name), contents)
      process.chdir(root)
      consola.error = ((...args: unknown[]) => {
        errors.push(args.map(String).join(' '))
      }) as typeof consola.error
      let thrown = ''
      try {
        await write()
      } catch (error) {
        thrown = (error as Error).message
      }
      return {
        after: realFs.readFileSync(join(root, 'deployments', name), 'utf8'),
        message: [thrown, ...errors].join('\n'),
      }
    } finally {
      consola.error = realError
      process.chdir(previousCwd)
      if (previousProduction === undefined) {
        delete process.env.PRODUCTION
      } else {
        process.env.PRODUCTION = previousProduction
      }
      realFs.rmSync(root, { recursive: true, force: true })
    }
  }

  const saveAddress = () => saveContractAddress('tron', 'EcoFacet', 'TAddr1')
  const updateFacet = () => updateDiamondJson('TAddr1', 'EcoFacet', '1.0.0')
  const updateBatch = () =>
    updateDiamondJsonBatch([
      { address: 'TAddr1', name: 'EcoFacet', version: '1.0.0' },
    ])
  const updatePeriphery = () => updateDiamondJsonPeriphery('TExec', 'Executor')

  it.each([
    [
      'saveContractAddress',
      'tron.json',
      '[]',
      saveAddress,
      /is not a JSON object/,
    ],
    [
      'saveContractAddress',
      'tron.json',
      'null',
      saveAddress,
      /is not a JSON object/,
    ],
    [
      'updateDiamondJson',
      'tron.diamond.json',
      '[]',
      updateFacet,
      /is not a JSON object/,
    ],
    [
      'updateDiamondJson',
      'tron.diamond.json',
      '{"LiFiDiamond":[]}',
      updateFacet,
      /LiFiDiamond is not an object/,
    ],
    [
      'updateDiamondJson',
      'tron.diamond.json',
      '{"LiFiDiamond":{"Facets":[]}}',
      updateFacet,
      /LiFiDiamond\.Facets is not an object/,
    ],
    [
      'updateDiamondJsonBatch',
      'tron.diamond.json',
      '{"LiFiDiamond":{"Facets":null}}',
      updateBatch,
      /LiFiDiamond\.Facets is not an object/,
    ],
    [
      'updateDiamondJsonPeriphery',
      'tron.diamond.json',
      '{"LiFiDiamond":{"Facets":{},"Periphery":[]}}',
      updatePeriphery,
      /LiFiDiamond\.Periphery is not an object/,
    ],
  ] as Array<[string, string, string, () => Promise<void>, RegExp]>)(
    '%s leaves %s holding %s untouched',
    async (_writer, name, contents, write, reason) => {
      const { after, message } = await withLog(name, contents, write)

      expect(after).toBe(contents)
      expect(message).toMatch(reason)
      expect(message).toMatch(/fix it, then record .* by hand/)
    }
  )
})

describe('getFacetSelectors artifact lookup', () => {
  it('names forge build as the fix when the artifact is missing', async () => {
    await expectRejects(
      getFacetSelectors('NoSuchFacetEverBuilt'),
      "Build artifact not found for NoSuchFacetEverBuilt. Run 'forge build' first."
    )
  })
})
