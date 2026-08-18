import { readFileSync } from 'fs'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  collectImmutableBindingChecks,
  isFacetContract,
  isValidConfigFileName,
  isZeroAddressValue,
  loadConfigFileFromDisk,
  redactUrls,
  resolveConfigValue,
  substituteConfigKeyPlaceholders,
  TRON_ZERO_ADDRESS_BASE58,
  type IDeployRequirementEntry,
} from './immutableBindings'

const SPOKE = '0x1111111111111111111111111111111111111111'

const REQUIREMENTS: Record<string, IDeployRequirementEntry> = {
  ReceiverAcrossV4: {
    configData: {
      _owner: {
        configFileName: 'global.json',
        keyInConfigFile: '.refundWallet',
        // No getter: the owner is asserted by receiver-owner, not by the binding check.
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

// Injected loader — the suite never touches config/ on disk, so it is hermetic.
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

  it('resolves a network key that starts with a digit', () => {
    // jq needs bracket notation for these (the bash consumer rewrites them); a plain segment
    // walk must handle them natively or coverage silently drops for such chains.
    expect(
      resolveConfigValue(
        { '0g': { portal: SPOKE } },
        '.<NETWORK>.portal',
        '0g',
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
    expect(resolveConfigValue(null, '.a', 'x', 'production')).toBeNull()
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
        legacyGetters: [],
        configFileName: 'missing.json',
        keyInConfigFile: '.a',
        resolvedKeyInConfigFile: '.a',
        expectedAddress: null,
      },
    ])
  })

  it('carries legacyGetters through, defaulting to an empty list', () => {
    const checks = collectImmutableBindingChecks(
      'mainnet',
      'production',
      {
        Renamed: {
          configData: {
            _a: {
              configFileName: 'across.json',
              keyInConfigFile: '.<NETWORK>.acrossSpokePool',
              getter: 'NEW_NAME',
              legacyGetters: ['oldName'],
            },
          },
        },
      },
      load
    )

    expect(checks[0]?.legacyGetters).toEqual(['oldName'])
    expect(
      collectImmutableBindingChecks('mainnet', 'production', REQUIREMENTS, load)
        .map((c) => c.legacyGetters)
        .every((l) => Array.isArray(l))
    ).toBe(true)
  })

  it('annotates the DeBridgeDlnFacet getter rename that most of the fleet predates', () => {
    // The bound address is identical fleet-wide, but only chains on v1.1.0+ expose DLN_SOURCE();
    // without the legacy name the binding silently goes unverified on every older chain.
    const check = collectImmutableBindingChecks('mainnet', 'production').find(
      (c) => c.contractName === 'DeBridgeDlnFacet'
    )
    expect(check?.getter).toBe('DLN_SOURCE')
    expect(check?.legacyGetters).toEqual(['dlnSource'])
  })

  it('skips an entry without configData', () => {
    expect(
      collectImmutableBindingChecks('mainnet', 'production', { X: {} }, load)
    ).toEqual([])
  })
})

describe('isZeroAddressValue', () => {
  it('recognizes both Tron zero-address encodings and the EVM one', () => {
    // A naive shape check passes all three, so a binding pointing at zero would read as a
    // legitimate address and the drift check would silently pass.
    expect(isZeroAddressValue(TRON_ZERO_ADDRESS_BASE58)).toBe(true)
    expect(
      isZeroAddressValue('410000000000000000000000000000000000000000')
    ).toBe(true)
    expect(
      isZeroAddressValue('0x0000000000000000000000000000000000000000')
    ).toBe(true)
    expect(isZeroAddressValue('0000000000000000000000000000000000000000')).toBe(
      true
    )
  })

  it('is case-insensitive for hex but not for base58', () => {
    expect(
      isZeroAddressValue('0X0000000000000000000000000000000000000000')
    ).toBe(true)
    expect(isZeroAddressValue(TRON_ZERO_ADDRESS_BASE58.toLowerCase())).toBe(
      false
    )
  })

  it('does not flag a real address', () => {
    expect(isZeroAddressValue('TBhZw2sb5DuqGXf3PcxMKDaqxtoZVUUtR7')).toBe(false)
    expect(isZeroAddressValue(SPOKE)).toBe(false)
    expect(isZeroAddressValue('')).toBe(false)
  })
})

describe('isFacetContract', () => {
  it('classifies real repo contracts from src/Facets', () => {
    expect(isFacetContract('MayanFacet')).toBe(true)
    expect(isFacetContract('EcoFacet')).toBe(true)
    expect(isFacetContract('DeBridgeDlnFacet')).toBe(true)
    // Periphery, despite the deploy log listing it alongside facets.
    expect(isFacetContract('ReceiverAcrossV4')).toBe(false)
    expect(isFacetContract('LidoWrapper')).toBe(false)
  })

  it('refuses names that could traverse out of src/Facets', () => {
    const probed: string[] = []
    const exists = (filePath: string) => {
      probed.push(filePath)
      return true
    }
    expect(isFacetContract('../../.something', exists)).toBe(false)
    expect(isFacetContract('a/b', exists)).toBe(false)
    expect(probed).toEqual([])
  })
})

describe('loadConfigFileFromDisk', () => {
  it('refuses path-traversal file names rather than reading outside config/', () => {
    expect(isValidConfigFileName('across.json')).toBe(true)
    expect(isValidConfigFileName('a/b.json')).toBe(false)
    expect(isValidConfigFileName('across.txt')).toBe(false)
    expect(loadConfigFileFromDisk('../../package.json')).toBeNull()
  })

  it('returns null for a file that does not exist', () => {
    expect(loadConfigFileFromDisk('definitely-not-a-config.json')).toBeNull()
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

  it('collects every shipped annotation', () => {
    const names = checks.map((c) => `${c.contractName}.${c.getter}`)
    expect(names).toContain('ReceiverAcrossV4.SPOKEPOOL')
    expect(names).toContain('ReceiverStargateV2.endpointV2')
    expect(names).toContain('ReceiverStargateV2.tokenMessaging')
    expect(names).toContain('ReceiverChainflip.chainflipVault')
    expect(names).toContain('ReceiverOIF.OUTPUT_SETTLER')
    expect(names).toContain('DeBridgeDlnFacet.DLN_SOURCE')
    expect(names).toContain('EcoFacet.PORTAL')
    expect(names).toContain('LidoWrapper.ST_ETH')
    expect(names).toContain('LidoWrapper.WST_ETH_ADDRESS')
    expect(names).toContain('MayanFacet.MAYAN')
  })

  it('every annotated getter exists in the contract artifact (skipped when out/ is absent)', async () => {
    for (const check of checks) {
      const file = Bun.file(
        `out/${check.contractName}.sol/${check.contractName}.json`
      )
      // Skipped, not failed, when out/ is absent: the TS unit-test job runs without a forge build.
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

  it('every annotated keyInConfigFile resolves on at least one network', () => {
    // An annotation whose path resolves nowhere degrades the invariant to a warning on every
    // chain, silently shrinking coverage instead of failing loudly.
    const networks = Object.keys(
      JSON.parse(readFileSync('config/networks.json', 'utf8')) as Record<
        string,
        unknown
      >
    )

    const resolvesSomewhere = new Map<string, boolean>()
    for (const network of networks)
      for (const check of collectImmutableBindingChecks(
        network,
        'production'
      )) {
        const key = `${check.contractName}.${check.argName}`
        resolvesSomewhere.set(
          key,
          (resolvesSomewhere.get(key) ?? false) ||
            check.expectedAddress !== null
        )
      }

    const dead = [...resolvesSomewhere.entries()]
      .filter(([, resolves]) => !resolves)
      .map(([key]) => key)
    expect(dead).toEqual([])
  })
})

describe('redactUrls', () => {
  it('strips a URL that tooling echoed back with the failing command', () => {
    // troncast failures echo their own invocation, and the RPC URL in it can embed an API key.
    const message =
      '$ bun run script/troncast/index.ts call "TXYZ" "PORTAL() returns (address)" --rpc-url https://rpc.example.invalid/jsonrpc?apikey=not-a-real-key'
    const redacted = redactUrls(message)
    expect(redacted).not.toContain('not-a-real-key')
    expect(redacted).not.toContain('example.invalid')
    expect(redacted).toContain('<redacted-url>')
  })

  it('leaves a message without a URL untouched', () => {
    expect(redactUrls('execution reverted')).toBe('execution reverted')
  })
})

describe('substituteConfigKeyPlaceholders', () => {
  it('substitutes both placeholders', () => {
    expect(
      substituteConfigKeyPlaceholders(
        '.<NETWORK>.x.<ENVIRONMENT>',
        'mainnet',
        'production'
      )
    ).toBe('.mainnet.x.production')
  })

  it('is a no-op for a key without placeholders', () => {
    expect(
      substituteConfigKeyPlaceholders('.refundWallet', 'mainnet', 'production')
    ).toBe('.refundWallet')
  })
})

describe('redactUrls — adversarial inputs', () => {
  it('redacts a URL glued to a preceding word character', () => {
    // A \b anchor fails here, so the whole match would fail and the URL would survive intact.
    for (const prefix of ['log_', '1', 'word', '[', 'msg:']) {
      const out = redactUrls(`${prefix}https://host/path?apikey=not-a-real-key`)
      expect(out).not.toContain('not-a-real-key')
    }
  })

  it('redacts non-http schemes too', () => {
    expect(redactUrls('ws://host/?k=not-a-real-key')).not.toContain(
      'not-a-real-key'
    )
  })
})
