/**
 * The registry fixture mirrors `AcrossFacet`'s real shape in
 * `deployRequirements.json`, with the config loader stubbed so no test reads
 * `config/`. Encoded expectations are written out as literal hex rather than
 * recomputed with the encoder the module uses, so a change of encoder is
 * visible here.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import type { IDeployRequirementEntry } from '../shared/immutableBindings'

import { deriveExpectedConstructorArgs } from './expected-constructor-args'
import type { IConstructorInput } from './expected-constructor-args'

const SPOKE_POOL = '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5'
const WRAPPED_NATIVE = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

/** The two 32-byte words `abi.encode(SPOKE_POOL, WRAPPED_NATIVE)` produces. */
const ENCODED_PAIR =
  '0000000000000000000000005c7bcd6e7de5423a257d81b442095a1a6ced35c5' +
  '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'

const INPUTS: IConstructorInput[] = [
  { name: '_spokePool', type: 'address' },
  { name: '_wrappedNative', type: 'address' },
]

const REQUIREMENTS: Record<string, IDeployRequirementEntry> = {
  AcrossFacet: {
    configData: {
      _spokePool: {
        configFileName: 'across.json',
        keyInConfigFile: '.<NETWORK>.acrossSpokePool',
      },
      _wrappedNative: {
        configFileName: 'networks.json',
        keyInConfigFile: '.<NETWORK>.wrappedNativeAddress',
      },
    },
  },
}

const CONFIG: Record<string, unknown> = {
  'across.json': { mainnet: { acrossSpokePool: SPOKE_POOL } },
  'networks.json': { mainnet: { wrappedNativeAddress: WRAPPED_NATIVE } },
}

const loader =
  (config: Record<string, unknown> = CONFIG) =>
  (fileName: string): unknown =>
    Object.prototype.hasOwnProperty.call(config, fileName)
      ? config[fileName]
      : null

const derive = (over: {
  contractName?: string
  inputs?: IConstructorInput[]
  requirements?: Record<string, IDeployRequirementEntry>
  config?: Record<string, unknown>
  recordedArgs?: string
  network?: string
}) =>
  deriveExpectedConstructorArgs(
    {
      contractName: over.contractName ?? 'AcrossFacet',
      inputs: over.inputs ?? INPUTS,
      network: over.network ?? 'mainnet',
      environment: 'production',
      recordedArgs: over.recordedArgs,
    },
    over.requirements ?? REQUIREMENTS,
    loader(over.config)
  )

describe('when config answers every constructor arg', () => {
  it('encodes the config values in declaration order', () => {
    const result = derive({})

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.encoded).toBe(ENCODED_PAIR)
    expect(result.args.map((arg) => arg.value)).toEqual([
      SPOKE_POOL,
      WRAPPED_NATIVE,
    ])
  })

  it('names the config file and the key that answered', () => {
    const result = derive({})

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.args.map((arg) => arg.origin)).toEqual([
      'config/across.json.mainnet.acrossSpokePool',
      'config/networks.json.mainnet.wrappedNativeAddress',
    ])
  })

  it('reads only the config files the registry names', () => {
    const asked: string[] = []
    deriveExpectedConstructorArgs(
      {
        contractName: 'AcrossFacet',
        inputs: INPUTS,
        network: 'mainnet',
        environment: 'production',
      },
      REQUIREMENTS,
      (fileName) => {
        asked.push(fileName)
        return CONFIG[fileName] ?? null
      }
    )

    expect(asked).toEqual(['across.json', 'networks.json'])
  })

  it('accepts a deployment record whose constructorArgs agree', () => {
    const result = derive({ recordedArgs: `0x${ENCODED_PAIR.toUpperCase()}` })

    expect(result.ok).toBe(true)
  })
})

describe('a nullary constructor', () => {
  it('derives an empty encoding without consulting the registry', () => {
    const result = derive({ inputs: [], requirements: {} })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.encoded).toBe('')
    expect(result.args).toEqual([])
  })

  it('still refuses when the record claims arguments it cannot have', () => {
    // The nullary shortcut used to return before the record cross-check, so the
    // one case where the two repo-controlled sources cannot both be right was
    // the one case that passed. A record carrying args against a constructor
    // that takes none is not a disagreement about a value — it says the record
    // describes a different build.
    const result = derive({
      inputs: [],
      requirements: {},
      recordedArgs: `0x${'11'.repeat(32)}`, // pre-commit-checker: not a secret
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('takes no arguments')
  })

  it('accepts a record that carries no args at all', () => {
    // The paired present: absence is not disagreement. Most records predate the
    // field, so refusing on absence would refuse the fleet.
    expect(derive({ inputs: [], requirements: {}, recordedArgs: '' }).ok).toBe(
      true
    )
    expect(derive({ inputs: [], requirements: {} }).ok).toBe(true)
  })
})

describe('when an arg has no config-side expectation', () => {
  it('refuses a contract the registry does not carry, naming it', () => {
    const result = derive({ requirements: {} })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('AcrossFacet')
    expect(result.reason).toContain('no configData')
  })

  it('refuses an unannotated arg, naming it', () => {
    const result = derive({
      requirements: {
        AcrossFacet: {
          configData: {
            _spokePool: {
              configFileName: 'across.json',
              keyInConfigFile: '.<NETWORK>.acrossSpokePool',
            },
          },
        },
      },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('_wrappedNative')
    expect(result.reason).toContain('not annotated')
  })

  it('refuses an arg type no config value can be encoded as', () => {
    const result = derive({
      inputs: [
        { name: '_spokePool', type: 'address' },
        { name: '_wrappedNative', type: 'bytes32' },
      ],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('is bytes32')
  })

  it('refuses when config has no value for this network', () => {
    const result = derive({ network: 'plasma' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('.plasma.acrossSpokePool')
    expect(result.reason).toContain('no value')
  })

  it('refuses when the config file itself cannot be read', () => {
    const result = derive({ config: {} })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('across.json')
  })

  it('refuses a config value that is not a 20-byte hex address', () => {
    const result = derive({
      config: {
        ...CONFIG,
        'across.json': {
          mainnet: { acrossSpokePool: 'TXFbqBqFP4YB1YQaMHm9dvvvMCB1JNfV1p' },
        },
      },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('not a 20-byte hex address')
  })

  it('does not resolve an arg named after an Object prototype member', () => {
    const result = derive({
      inputs: [{ name: 'constructor', type: 'address' }],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('not annotated')
  })
})

describe('when our own two sources disagree', () => {
  it('refuses rather than preferring either', () => {
    const result = derive({
      recordedArgs:
        '0000000000000000000000005c7bcd6e7de5423a257d81b442095a1a6ced35c5' +
        '000000000000000000000000dead000000000000000000000000000000000000',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('disagree')
  })

  it('treats an empty recorded field as no cross-check rather than a disagreement', () => {
    const result = derive({ recordedArgs: '' })

    expect(result.ok).toBe(true)
  })
})
