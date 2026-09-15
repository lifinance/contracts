import { readFileSync } from 'fs'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  collectImmutableBindingChecks,
  compareContractVersions,
  isFacetContract,
  isValidConfigFileName,
  isZeroAddressValue,
  loadConfigFileFromDisk,
  loadDiamondFacetLogFromDisk,
  resolveConfigValue,
  resolveRegisteredFacetVersion,
  resolveExpectedAddress,
  substituteConfigKeyPlaceholders,
  TRON_ZERO_ADDRESS_BASE58,
  type DiamondFacetLog,
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
        getterSinceVersion: null,
        configFileName: 'missing.json',
        keyInConfigFile: '.a',
        resolvedKeyInConfigFile: '.a',
        expectedAddress: null,
        zeroAddressAllowed: false,
        configFileLoaded: false,
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

  it('carries allowToDeployWithZeroAddress as zeroAddressAllowed', () => {
    // The flag is the only record that a zero read is deliberate rather than drift; a collector
    // that drops it forces every consumer to re-open the registry to find out.
    const checks = collectImmutableBindingChecks(
      'mainnet',
      'production',
      {
        Optional: {
          configData: {
            _a: {
              configFileName: 'across.json',
              keyInConfigFile: '.<NETWORK>.acrossSpokePool',
              allowToDeployWithZeroAddress: 'true',
              getter: 'A',
            },
          },
        },
        Required: {
          configData: {
            _b: {
              configFileName: 'across.json',
              keyInConfigFile: '.<NETWORK>.acrossSpokePool',
              allowToDeployWithZeroAddress: 'false',
              getter: 'B',
            },
          },
        },
        Unstated: {
          configData: {
            _c: {
              configFileName: 'across.json',
              keyInConfigFile: '.<NETWORK>.acrossSpokePool',
              getter: 'C',
            },
          },
        },
      },
      load
    )

    expect(checks.map((c) => [c.contractName, c.zeroAddressAllowed])).toEqual([
      ['Optional', true],
      ['Required', false],
      ['Unstated', false],
    ])
  })

  it('distinguishes an unreadable config file from a key that file does not carry', () => {
    // Both resolve to a null expectedAddress, but only the second one proves the deployment used
    // the zero default — treating an unreadable file the same way would assert zero fleet-wide
    // on nothing more than a missing file.
    const registry: Record<string, IDeployRequirementEntry> = {
      Missing: {
        configData: {
          _a: {
            configFileName: 'missing.json',
            keyInConfigFile: '.a',
            getter: 'A',
          },
        },
      },
      Absent: {
        configData: {
          _a: {
            configFileName: 'across.json',
            keyInConfigFile: '.<NETWORK>.notAKey',
            getter: 'A',
          },
        },
      },
    }

    const checks = collectImmutableBindingChecks(
      'mainnet',
      'production',
      registry,
      load
    )

    expect(
      checks.map((c) => [c.contractName, c.configFileLoaded, c.expectedAddress])
    ).toEqual([
      ['Absent', true, null],
      ['Missing', false, null],
    ])
  })

  it('does not count a config file that parsed to a non-object as loaded', () => {
    // Valid JSON that is not an object carries no keys, so every lookup in it resolves to null.
    // Counting it as loaded turns a corrupted file into a fleet-wide "the value is zero" claim.
    const checks = collectImmutableBindingChecks(
      'mainnet',
      'production',
      {
        Scalar: {
          configData: {
            _a: {
              configFileName: 'scalar.json',
              keyInConfigFile: '.a',
              allowToDeployWithZeroAddress: 'true',
              getter: 'A',
            },
          },
        },
        Listy: {
          configData: {
            _a: {
              configFileName: 'listy.json',
              keyInConfigFile: '.a',
              allowToDeployWithZeroAddress: 'true',
              getter: 'A',
            },
          },
        },
      },
      (name: string) => (name === 'scalar.json' ? false : [])
    )

    expect(checks.map((c) => [c.contractName, c.configFileLoaded])).toEqual([
      ['Listy', false],
      ['Scalar', false],
    ])
  })

  it('resolves no expectation at all from a config file it did not load', () => {
    // A numeric path segment indexes a list, so a file that is one can still answer a key. That
    // pairs a value the caller is told not to trust with a flag saying the file is unusable.
    const checks = collectImmutableBindingChecks(
      'mainnet',
      'production',
      {
        Indexed: {
          configData: {
            _a: {
              configFileName: 'listy.json',
              keyInConfigFile: '.0',
              getter: 'A',
            },
          },
        },
      },
      () => ['0x1111111111111111111111111111111111111111']
    )

    expect(checks[0]?.configFileLoaded).toBe(false)
    expect(checks[0]?.expectedAddress).toBeNull()
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

describe('resolveExpectedAddress network-scoped override', () => {
  const intentEscrow = loadConfigFileFromDisk('lifiintentescrow.json')

  it('prefers the .tron override over the fleet-wide key (real config)', () => {
    const flat = resolveConfigValue(
      intentEscrow,
      '.OIFOutputSettlerSimple',
      'tron',
      'production'
    )
    const resolved = resolveExpectedAddress(
      intentEscrow,
      '.OIFOutputSettlerSimple',
      'tron',
      'production'
    )

    expect(resolved.keyUsed).toBe('.tron.OIFOutputSettlerSimple')
    expect(resolved.expectedAddress).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/)
    // Without the override the Tron binding would be compared against the EVM address, so an
    // correctly bound contract would be reported as drift by an error-severity invariant.
    expect(resolved.expectedAddress).not.toBe(flat)
  })

  it('falls back to the fleet-wide key on a network without an override', () => {
    expect(
      resolveExpectedAddress(
        intentEscrow,
        '.OIFOutputSettlerSimple',
        'mainnet',
        'production'
      )
    ).toEqual({
      keyUsed: '.OIFOutputSettlerSimple',
      expectedAddress: resolveConfigValue(
        intentEscrow,
        '.OIFOutputSettlerSimple',
        'mainnet',
        'production'
      ),
    })
  })

  it('leaves a key that already targets one network alone', () => {
    const config = {
      tron: { mainnet: { x: '0xdead' } },
      mainnet: { x: '0xbeef' },
    }
    expect(
      resolveExpectedAddress(config, '.<NETWORK>.x', 'mainnet', 'production')
    ).toEqual({ keyUsed: '.<NETWORK>.x', expectedAddress: '0xbeef' })
  })

  it('reports no value when config could not be loaded', () => {
    expect(
      resolveExpectedAddress(
        null,
        '.OIFOutputSettlerSimple',
        'tron',
        'production'
      )
    ).toEqual({ keyUsed: '.OIFOutputSettlerSimple', expectedAddress: null })
  })
})

describe('getterSinceVersion', () => {
  const load = (name: string): unknown =>
    name === 'across.json' ? { mainnet: { acrossSpokePool: SPOKE } } : null

  it('carries the annotation through, defaulting to null', () => {
    const checks = collectImmutableBindingChecks(
      'mainnet',
      'production',
      {
        Added: {
          configData: {
            _a: {
              configFileName: 'across.json',
              keyInConfigFile: '.<NETWORK>.acrossSpokePool',
              getter: 'NEW_GETTER',
              getterSinceVersion: '1.0.1',
            },
            _b: {
              configFileName: 'across.json',
              keyInConfigFile: '.<NETWORK>.acrossSpokePool',
              getter: 'ALWAYS_THERE',
            },
          },
        },
      },
      load
    )

    expect(checks.map((c) => c.getterSinceVersion)).toEqual(['1.0.1', null])
  })

  it('annotates the GenericSwapFacetV3 getter that 16 production chains predate', () => {
    // NATIVE_ADDRESS arrived with the _nativeAddress constructor arg in v1.0.1; every v1.0.0
    // deployment reverts the read, which is a pending upgrade rather than a broken binding.
    const check = collectImmutableBindingChecks('mainnet', 'production').find(
      (c) => c.contractName === 'GenericSwapFacetV3'
    )
    expect(check?.getter).toBe('NATIVE_ADDRESS')
    expect(check?.getterSinceVersion).toBe('1.0.1')
  })
})

describe('compareContractVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareContractVersions('1.0.0', '1.0.1')).toBeLessThan(0)
    expect(compareContractVersions('1.0.2', '1.1.0')).toBeLessThan(0)
    expect(compareContractVersions('2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareContractVersions('1.0.1', '1.0.1')).toBe(0)
  })

  it('compares parts numerically rather than as text', () => {
    expect(compareContractVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
  })

  it('refuses to order anything that is not a three-part numeric version', () => {
    // A mistyped annotation must not order against anything: inventing a result would silently
    // exempt the binding from the check rather than leaving it checked.
    expect(compareContractVersions('1.0', '1.0.0')).toBeNull()
    expect(compareContractVersions('1.0.2-tron', '1.0.2')).toBeNull()
    expect(
      compareContractVersions('[error] could not find src', '1.0.0')
    ).toBeNull()
  })
})

describe('resolveRegisteredFacetVersion', () => {
  const OLD = '0x31a9b1835864706Af10103b31Ea2b79bdb995F5F'
  const NEW = '0x8C9dBA771220Ed09580b77F0765e7153fbDE7790'
  const TRON = 'TLDz16QnvAN8pDS7GhNCimwVhYGHrsjZjz'

  const LOG: DiamondFacetLog = {
    [OLD]: { Name: 'GenericSwapFacetV3', Version: '1.0.0' },
    [NEW]: { Name: 'GenericSwapFacetV3', Version: '1.0.2' },
    [TRON]: { Name: 'GenericSwapFacetV3', Version: '1.0.2' },
    '0x0000000000000000000000000000000000000002': {
      Name: 'DiamondCutFacet',
      Version: '',
    },
  }

  it('resolves the version registered at an address', () => {
    expect(
      resolveRegisteredFacetVersion('GenericSwapFacetV3', 'mainnet', OLD, LOG)
    ).toBe('1.0.0')
    expect(
      resolveRegisteredFacetVersion('GenericSwapFacetV3', 'mainnet', NEW, LOG)
    ).toBe('1.0.2')
  })

  it('ignores checksum casing on hex addresses', () => {
    expect(
      resolveRegisteredFacetVersion(
        'GenericSwapFacetV3',
        'mainnet',
        OLD.toLowerCase(),
        LOG
      )
    ).toBe('1.0.0')
  })

  it('matches Tron base58 exactly, where case carries information', () => {
    expect(
      resolveRegisteredFacetVersion('GenericSwapFacetV3', 'tron', TRON, LOG)
    ).toBe('1.0.2')
    expect(
      resolveRegisteredFacetVersion(
        'GenericSwapFacetV3',
        'tron',
        TRON.toLowerCase(),
        LOG
      )
    ).toBeNull()
  })

  it('refuses to answer from an entry naming a different contract', () => {
    // A reassigned log line would otherwise hand back a version read off the wrong build.
    expect(
      resolveRegisteredFacetVersion('AcrossFacetV4', 'mainnet', OLD, LOG)
    ).toBeNull()
  })

  it('reports null for an unrecorded address, a blank version and an unreadable log', () => {
    expect(
      resolveRegisteredFacetVersion(
        'GenericSwapFacetV3',
        'mainnet',
        '0x0000000000000000000000000000000000000001',
        LOG
      )
    ).toBeNull()
    expect(
      resolveRegisteredFacetVersion(
        'DiamondCutFacet',
        'mainnet',
        '0x0000000000000000000000000000000000000002',
        LOG
      )
    ).toBeNull()
    expect(
      resolveRegisteredFacetVersion('GenericSwapFacetV3', 'mainnet', OLD, null)
    ).toBeNull()
  })

  it('refuses a network name that could escape the deployments directory', () => {
    expect(loadDiamondFacetLogFromDisk('../../etc/passwd')).toBeNull()
  })

  it('reads the real diamond logs, where arbitrum still serves v1.0.0', () => {
    expect(
      resolveRegisteredFacetVersion('GenericSwapFacetV3', 'arbitrum', OLD)
    ).toBe('1.0.0')
    expect(
      resolveRegisteredFacetVersion('GenericSwapFacetV3', 'mainnet', NEW)
    ).toBe('1.0.2')
  })
})
