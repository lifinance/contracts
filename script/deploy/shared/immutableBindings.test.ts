import { readFileSync } from 'fs'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  collectImmutableBindingChecks,
  isValidConfigFileName,
  loadConfigFileFromDisk,
  resolveConfigValue,
  type IDeployRequirementEntry,
} from './immutableBindings'

const SPOKE = '0x1111111111111111111111111111111111111111'

const REQUIREMENTS: Record<string, IDeployRequirementEntry> = {
  ReceiverAcrossV4: {
    configData: {
      _owner: {
        configFileName: 'global.json',
        keyInConfigFile: '.refundWallet',
        // No getter: owner is asserted by receiver-owner, not by the binding check.
      },
      _spokepool: {
        configFileName: 'across.json',
        keyInConfigFile: '.<NETWORK>.acrossSpokePool',
        getter: 'SPOKEPOOL',
      },
    },
  },
  SomeFacet: {
    configData: {
      _router: {
        configFileName: 'some.json',
        keyInConfigFile: '.router.<NETWORK>',
        getter: 'router',
      },
    },
  },
}

// Injected loader - the suite never touches config/ on disk, so it is hermetic.
const CONFIG_FILES: Record<string, unknown> = {
  'across.json': { mainnet: { acrossSpokePool: SPOKE } },
  'some.json': { router: {} },
}
const load = (name: string) => CONFIG_FILES[name] ?? null

describe('resolveConfigValue', () => {
  it('substitutes <NETWORK> and walks the dot path', () => {
    expect(
      resolveConfigValue(
        { mainnet: { acrossSpokePool: SPOKE } },
        '.<NETWORK>.acrossSpokePool',
        'mainnet',
        'production'
      )
    ).toBe(SPOKE)
  })

  it('returns null when a segment is absent', () => {
    expect(
      resolveConfigValue(
        {},
        '.<NETWORK>.acrossSpokePool',
        'mainnet',
        'production'
      )
    ).toBeNull()
  })

  it('returns null for non-string and empty values', () => {
    expect(resolveConfigValue({ a: 5 }, '.a', 'x', 'production')).toBeNull()
    expect(resolveConfigValue({ a: '' }, '.a', 'x', 'production')).toBeNull()
  })

  it('substitutes <ENVIRONMENT>', () => {
    expect(
      resolveConfigValue(
        { backendSigner: { production: SPOKE } },
        '.backendSigner.<ENVIRONMENT>',
        'mainnet',
        'production'
      )
    ).toBe(SPOKE)
  })
})

describe('collectImmutableBindingChecks', () => {
  it('collects only getter-annotated args, with the config-resolved expected address', () => {
    const checks = collectImmutableBindingChecks(
      'mainnet',
      'production',
      REQUIREMENTS,
      load
    )

    expect(checks.map((c) => `${c.contractName}.${c.argName}`)).toEqual([
      'ReceiverAcrossV4._spokepool',
      'SomeFacet._router',
    ])
    expect(checks[0]?.getter).toBe('SPOKEPOOL')
    expect(checks[0]?.expectedAddress).toBe(SPOKE)
  })

  it('reports null expectedAddress when config has no value for the network', () => {
    const checks = collectImmutableBindingChecks(
      'unknownchain',
      'production',
      REQUIREMENTS,
      load
    )

    expect(checks.every((c) => c.expectedAddress === null)).toBe(true)
  })

  it('reports null expectedAddress when the config file cannot be loaded', () => {
    const checks = collectImmutableBindingChecks(
      'mainnet',
      'production',
      {
        X: {
          configData: {
            _a: {
              configFileName: 'missing.json',
              keyInConfigFile: '.a',
              getter: 'a',
            },
          },
        },
      },
      load
    )

    expect(checks).toEqual([
      {
        contractName: 'X',
        argName: '_a',
        getter: 'a',
        configFileName: 'missing.json',
        keyInConfigFile: '.a',
        expectedAddress: null,
      },
    ])
  })
})

describe('loadConfigFileFromDisk', () => {
  it('refuses path-traversal file names rather than reading outside config/', () => {
    expect(isValidConfigFileName('across.json')).toBe(true)
    expect(isValidConfigFileName('../.env')).toBe(false)
    expect(isValidConfigFileName('a/b.json')).toBe(false)
    expect(loadConfigFileFromDisk('../../.env')).toBeNull()
  })

  it('loads a real config file', () => {
    const global = loadConfigFileFromDisk('global.json') as Record<
      string,
      unknown
    >
    expect(global).not.toBeNull()
    expect(typeof global.refundWallet).toBe('string')
  })
})

describe('deployRequirements.json getter annotations', () => {
  const checks = collectImmutableBindingChecks('mainnet', 'production')

  it('the shipped annotations are collected (ReceiverAcrossV4, ReceiverStargateV2, ReceiverChainflip)', () => {
    const names = checks.map((c) => `${c.contractName}.${c.getter}`)
    expect(names).toContain('ReceiverAcrossV4.SPOKEPOOL')
    expect(names).toContain('ReceiverStargateV2.endpointV2')
    expect(names).toContain('ReceiverStargateV2.tokenMessaging')
    expect(names).toContain('ReceiverChainflip.chainflipVault')
  })

  it('every annotated getter exists in the contract artifact (skip when out/ is absent)', async () => {
    for (const check of checks) {
      const artifactPath = `out/${check.contractName}.sol/${check.contractName}.json`
      const file = Bun.file(artifactPath)
      // Skipped, not failed, when out/ is absent (the TS unit-test job runs without forge build).
      if (!(await file.exists())) continue

      const artifact = (await file.json()) as {
        methodIdentifiers?: Record<string, string>
      }
      expect(
        Object.keys(artifact.methodIdentifiers ?? {}),
        `${check.contractName}: getter ${check.getter}() must exist on the contract`
      ).toContain(`${check.getter}()`)
    }
  })

  it('every annotated keyInConfigFile resolves on at least one production network', () => {
    // resolveConfigValue only walks plain dot paths - a jq-quoted segment (e.g.
    // `."my-chain".x`) resolves to null everywhere and the invariant degrades to a warning,
    // silently shrinking coverage. An annotation that resolves nowhere is a broken annotation.
    const networks = Object.keys(
      JSON.parse(readFileSync('config/networks.json', 'utf8')) as Record<
        string,
        unknown
      >
    )

    const annotated = new Map<string, boolean>()
    for (const network of networks)
      for (const check of collectImmutableBindingChecks(
        network,
        'production'
      )) {
        const key = `${check.contractName}.${check.argName}`
        annotated.set(
          key,
          (annotated.get(key) ?? false) || check.expectedAddress !== null
        )
      }

    const dead = [...annotated.entries()]
      .filter(([, resolves]) => !resolves)
      .map(([key]) => key)
    expect(dead).toEqual([])
  })
})
