/**
 * Tests for the whitelist pair logic behind the combined registration +
 * whitelist-sync proposal. The dangerous half is the REMOVAL set: any pair the
 * config fails to produce is proposed for de-whitelisting on a live diamond.
 *
 * The case that matters most is the approveTo-only entry — a DEXS or PERIPHERY
 * contract with no listed functions is whitelisted under the `0xffffffff`
 * sentinel (LibAllowList.sol). Reading such an entry as "no pairs" would
 * de-whitelist live approveTo DEX targets fleet-wide, so it is asserted
 * explicitly here and through the diff.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import {
  decodeFunctionData,
  getAddress,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'

import globalConfig from '../../config/global.json'

import {
  APPROVE_TO_ONLY,
  assertRegisteredAddressIsDesired,
  assertWhitelistListsRegistrations,
  buildPairedRegistrationBatch,
  chunkPairs,
  desiredPairs,
  diffPairs,
  pairKey,
  peripheryRegistrationRoute,
  requiredSelectorsFor,
  type IPeripheryRouteConfig,
  type IWhitelistConfig,
} from './proposePeripheryWithWhitelist'

const NETWORK = 'arbitrum'
const OTHER_NETWORK = 'polygon'

// hex letters on purpose: an all-digit address makes any casing assertion vacuous
const DEX_WITH_FUNCTIONS = '0xdef1c0ded9bec7f1a1670819833240f027b25eff'
const DEX_APPROVE_TO_ONLY = '0x2222222222222222222222222222222222222222'
const PERIPHERY_WITH_SELECTORS = '0x3333333333333333333333333333333333333333'
const PERIPHERY_APPROVE_TO_ONLY = '0x4444444444444444444444444444444444444444'
const FOREIGN_DEX = '0x5555555555555555555555555555555555555555'

const SWAP = '0x12aa3caf'
const DEPOSIT = '0xd0e30db0'
const WITHDRAW = '0x2e1a7d4d'

const config: IWhitelistConfig = {
  DEXS: [
    {
      contracts: {
        [NETWORK]: [
          {
            address: DEX_WITH_FUNCTIONS,
            functions: { [SWAP]: 'swap(...)', [DEPOSIT]: 'deposit()' },
          },
          { address: DEX_APPROVE_TO_ONLY, functions: {} },
        ],
        [OTHER_NETWORK]: [
          { address: FOREIGN_DEX, functions: { [SWAP]: 'swap(...)' } },
        ],
      },
    },
  ],
  PERIPHERY: {
    [NETWORK]: [
      {
        address: PERIPHERY_WITH_SELECTORS,
        selectors: [{ selector: WITHDRAW }],
      },
      { address: PERIPHERY_APPROVE_TO_ONLY, selectors: [] },
    ],
  },
}

const pair = (contract: string, selector: string) => ({
  contract: getAddress(contract),
  selector: selector as Hex,
})

describe('desiredPairs', () => {
  it('expands a DEX entry into one pair per listed function', () => {
    const keys = desiredPairs(config, NETWORK).map(pairKey)
    expect(keys).toContain(pairKey(pair(DEX_WITH_FUNCTIONS, SWAP)))
    expect(keys).toContain(pairKey(pair(DEX_WITH_FUNCTIONS, DEPOSIT)))
  })

  it('maps a DEX entry with no functions to the approveTo-only sentinel', () => {
    const keys = desiredPairs(config, NETWORK).map(pairKey)
    expect(keys).toContain(pairKey(pair(DEX_APPROVE_TO_ONLY, APPROVE_TO_ONLY)))
  })

  it('maps a PERIPHERY entry with no selectors to the approveTo-only sentinel', () => {
    const keys = desiredPairs(config, NETWORK).map(pairKey)
    expect(keys).toContain(
      pairKey(pair(PERIPHERY_APPROVE_TO_ONLY, APPROVE_TO_ONLY))
    )
  })

  it('treats a missing functions/selectors key like an empty one', () => {
    const pairs = desiredPairs(
      {
        DEXS: [
          { contracts: { [NETWORK]: [{ address: DEX_APPROVE_TO_ONLY }] } },
        ],
        PERIPHERY: { [NETWORK]: [{ address: PERIPHERY_APPROVE_TO_ONLY }] },
      },
      NETWORK
    )
    expect(pairs.map((p) => p.selector)).toEqual([
      APPROVE_TO_ONLY,
      APPROVE_TO_ONLY,
    ])
  })

  it('covers both sections and no other network', () => {
    const keys = desiredPairs(config, NETWORK).map(pairKey)
    expect(keys).toContain(pairKey(pair(PERIPHERY_WITH_SELECTORS, WITHDRAW)))
    expect(keys).not.toContain(pairKey(pair(FOREIGN_DEX, SWAP)))
    expect(keys.length).toBe(5)
  })

  it('checksums addresses so config casing cannot fork a pair', () => {
    const upper = `0x${DEX_WITH_FUNCTIONS.slice(2).toUpperCase()}`
    expect(upper).not.toBe(DEX_WITH_FUNCTIONS) // guard: the fixture must have letters
    const [entry] = desiredPairs(
      {
        DEXS: [
          {
            contracts: {
              [NETWORK]: [
                { address: upper, functions: { [SWAP]: 'swap(...)' } },
              ],
            },
          },
        ],
      },
      NETWORK
    )
    expect(entry?.contract).toBe(getAddress(DEX_WITH_FUNCTIONS))
    // the diff must see the differently-cased config and on-chain forms as one pair
    const { toAdd, toRemove } = diffPairs(
      [pair(upper, SWAP)],
      [pair(DEX_WITH_FUNCTIONS.toLowerCase(), SWAP)]
    )
    expect(toAdd).toEqual([])
    expect(toRemove).toEqual([])
  })

  it('returns nothing for a network absent from both sections', () => {
    expect(desiredPairs(config, 'unknown-network')).toEqual([])
    expect(desiredPairs({}, NETWORK)).toEqual([])
  })
})

describe('diffPairs', () => {
  it('never proposes removing a live approveTo-only pair the config still lists', () => {
    const onChain = desiredPairs(config, NETWORK).map((p) => ({
      contract: p.contract.toLowerCase() as `0x${string}`,
      selector: p.selector,
    }))
    const { toAdd, toRemove } = diffPairs(
      desiredPairs(config, NETWORK),
      onChain
    )
    expect(toAdd).toEqual([])
    expect(toRemove).toEqual([])
  })

  it('removes only the on-chain pairs the config no longer lists', () => {
    const stale = pair(FOREIGN_DEX, SWAP)
    const { toAdd, toRemove } = diffPairs(desiredPairs(config, NETWORK), [
      pair(DEX_APPROVE_TO_ONLY, APPROVE_TO_ONLY),
      stale,
    ])
    expect(toRemove.map(pairKey)).toEqual([pairKey(stale)])
    expect(toAdd.map(pairKey)).not.toContain(
      pairKey(pair(DEX_APPROVE_TO_ONLY, APPROVE_TO_ONLY))
    )
    expect(toAdd.length).toBe(4)
  })

  it('adds every desired pair when the diamond has none', () => {
    const desired = desiredPairs(config, NETWORK)
    const { toAdd, toRemove } = diffPairs(desired, [])
    expect(toAdd.map(pairKey)).toEqual(desired.map(pairKey))
    expect(toRemove).toEqual([])
  })
})

describe('assertRegisteredAddressIsDesired', () => {
  it('passes when the config lists the address being registered', () => {
    expect(() =>
      assertRegisteredAddressIsDesired(
        desiredPairs(config, NETWORK),
        getAddress(PERIPHERY_WITH_SELECTORS),
        NETWORK
      )
    ).not.toThrow()
  })

  it('throws on a config that predates the deploy', () => {
    // the stale-config inversion: the batch would register the new address while
    // whitelisting the old one and de-whitelisting the new one
    expect(() =>
      assertRegisteredAddressIsDesired(
        desiredPairs(config, NETWORK),
        getAddress('0x9999999999999999999999999999999999999999'),
        NETWORK
      )
    ).toThrow(/does not list/)
  })

  it('matches case-insensitively', () => {
    expect(() =>
      assertRegisteredAddressIsDesired(
        [pair(DEX_WITH_FUNCTIONS.toLowerCase(), SWAP)],
        getAddress(DEX_WITH_FUNCTIONS),
        NETWORK
      )
    ).not.toThrow()
  })
})

describe('chunkPairs', () => {
  const many = Array.from({ length: 310 }, (_, i) =>
    pair(`0x${(i + 1).toString(16).padStart(40, '0')}`, SWAP)
  )

  it('never emits a call above the per-call ceiling', () => {
    const chunks = chunkPairs(many)
    expect(chunks.every((c) => c.length <= 150)).toBe(true)
    expect(chunks.flat().map(pairKey)).toEqual(many.map(pairKey))
  })

  it('emits one chunk when the set fits', () => {
    expect(chunkPairs(many.slice(0, 7))).toHaveLength(1)
  })

  it('emits nothing for an empty set', () => {
    expect(chunkPairs([])).toEqual([])
  })
})

const DIAMOND = getAddress('0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE')
const OLD_WRAPPER = getAddress('0x5215E9fd223BC909083fbdB2860213873046e45d')
const NEW_WRAPPER = getAddress('0x254bA6498aDDA926C75d49E9909f308bFaf4720E')
const OTHER_PERIPHERY = getAddress('0xFafE4c4CEc5Ed070A4aFDc0f92826c5Ba276Cb80')
const WRAP_DEPOSIT = '0xd0e30db0'
const WRAP_WITHDRAW = '0x3ccfd60b'

const routeConfig: IPeripheryRouteConfig = {
  whitelistPeripheryFunctions: {
    TokenWrapper: [
      { selector: WRAP_DEPOSIT, signature: 'deposit()' },
      { selector: WRAP_WITHDRAW, signature: 'withdraw()' },
    ],
    LiFiDEXAggregator: [{ selector: '0x2646478b', signature: 'x()' }],
  },
  whitelistPeripheryNetworks: { LiFiDEXAggregator: ['lens'] },
}

const wrapperConfig = (address: string, selectors: string[]) =>
  ({
    PERIPHERY: {
      fuse: [
        {
          address,
          selectors: selectors.map((selector) => ({ selector })),
        },
        {
          address: OTHER_PERIPHERY,
          selectors: [{ selector: '0x27444dab' }],
        },
      ],
    },
  } satisfies IWhitelistConfig)

const DECODE_ABI = parseAbi([
  'function registerPeripheryContract(string,address)',
  'function batchSetContractSelectorWhitelist(address[],bytes4[],bool)',
])

const decodeAll = (calldatas: readonly Hex[]) =>
  calldatas.map((data) => decodeFunctionData({ abi: DECODE_ABI, data }))

describe('peripheryRegistrationRoute', () => {
  it('pairs a diamond-called contract on an unscoped network', () => {
    expect(
      peripheryRegistrationRoute('TokenWrapper', 'fuse', routeConfig)
    ).toBe('paired')
  })

  it('leaves a name outside whitelistPeripheryFunctions on the plain route', () => {
    expect(
      peripheryRegistrationRoute('FeeCollector', 'fuse', routeConfig)
    ).toBe('not-diamond-called')
  })

  it('leaves an out-of-scope LiFiDEXAggregator on the plain route', () => {
    expect(
      peripheryRegistrationRoute('LiFiDEXAggregator', 'fuse', routeConfig)
    ).toBe('out-of-scope')
    // the in-scope control, so the out-of-scope answer is not the only one it gives
    expect(
      peripheryRegistrationRoute('LiFiDEXAggregator', 'LENS', routeConfig)
    ).toBe('paired')
  })

  it('does not read a prototype member as a configured contract', () => {
    expect(peripheryRegistrationRoute('constructor', 'fuse', routeConfig)).toBe(
      'not-diamond-called'
    )
    expect(peripheryRegistrationRoute('toString', 'fuse', routeConfig)).toBe(
      'not-diamond-called'
    )
  })

  it('refuses a scope map naming a contract with no functions', () => {
    expect(() =>
      peripheryRegistrationRoute('TokenWrapper', 'fuse', {
        ...routeConfig,
        whitelistPeripheryNetworks: { TokenWraper: ['fuse'] },
      })
    ).toThrow(/absent from whitelistPeripheryFunctions/)
  })

  it('answers from the committed config/global.json', () => {
    const real = globalConfig as unknown as IPeripheryRouteConfig
    expect(peripheryRegistrationRoute('TokenWrapper', 'fuse', real)).toBe(
      'paired'
    )
    expect(peripheryRegistrationRoute('FeeCollector', 'fuse', real)).toBe(
      'not-diamond-called'
    )
    expect(peripheryRegistrationRoute('LiFiDEXAggregator', 'fuse', real)).toBe(
      'out-of-scope'
    )
    expect(peripheryRegistrationRoute('LiFiDEXAggregator', 'lens', real)).toBe(
      'paired'
    )
  })
})

describe('requiredSelectorsFor', () => {
  it('lowercases the configured selectors', () => {
    expect(
      requiredSelectorsFor('Patcher', {
        whitelistPeripheryFunctions: {
          Patcher: [{ selector: '0xEFAE576B', signature: 'x()' }],
        },
      })
    ).toEqual(['0xefae576b'])
  })

  it('refuses a diamond-called name that lists no selector', () => {
    expect(() =>
      requiredSelectorsFor('Patcher', {
        whitelistPeripheryFunctions: { Patcher: [] },
      })
    ).toThrow(/lists no selector/)
  })
})

describe('assertWhitelistListsRegistrations', () => {
  const required = [WRAP_DEPOSIT, WRAP_WITHDRAW] as Hex[]
  const registration = (address: Address) => [
    { name: 'TokenWrapper', address, required },
  ]

  it('passes when whitelist.json lists the new address with every selector', () => {
    const desired = desiredPairs(
      wrapperConfig(NEW_WRAPPER, [WRAP_WITHDRAW, WRAP_DEPOSIT]),
      'fuse'
    )
    expect(() =>
      assertWhitelistListsRegistrations(
        desired,
        registration(NEW_WRAPPER),
        'fuse'
      )
    ).not.toThrow()
  })

  it('refuses while whitelist.json still lists the old address', () => {
    const desired = desiredPairs(
      wrapperConfig(OLD_WRAPPER, [WRAP_WITHDRAW, WRAP_DEPOSIT]),
      'fuse'
    )
    expect(() =>
      assertWhitelistListsRegistrations(
        desired,
        registration(NEW_WRAPPER),
        'fuse'
      )
    ).toThrow(/update config\/whitelist\.json first/)
  })

  it('refuses when whitelist.json lists the address without every selector', () => {
    const desired = desiredPairs(
      wrapperConfig(NEW_WRAPPER, [WRAP_DEPOSIT]),
      'fuse'
    )
    expect(() =>
      assertWhitelistListsRegistrations(
        desired,
        registration(NEW_WRAPPER),
        'fuse'
      )
    ).toThrow(/without 0x3ccfd60b/)
  })
})

describe('buildPairedRegistrationBatch', () => {
  const required = [WRAP_DEPOSIT, WRAP_WITHDRAW] as Hex[]
  const onChain = [
    pair(OLD_WRAPPER, WRAP_DEPOSIT),
    pair(OLD_WRAPPER, WRAP_WITHDRAW),
    pair(OTHER_PERIPHERY, '0x27444dab'),
  ]
  const build = (
    config: IWhitelistConfig,
    options: { actual?: typeof onChain; codeless?: string[] } = {}
  ) =>
    buildPairedRegistrationBatch({
      network: 'fuse',
      diamond: DIAMOND,
      registrations: [{ name: 'TokenWrapper', address: NEW_WRAPPER, required }],
      desired: desiredPairs(config, 'fuse'),
      actual: options.actual ?? onChain,
      codeless: new Set(options.codeless ?? []),
    })

  it('puts the registration and both whitelist writes in one batch, all on the diamond', () => {
    const batch = build(
      wrapperConfig(NEW_WRAPPER, [WRAP_WITHDRAW, WRAP_DEPOSIT])
    )
    expect(batch.targets).toEqual([DIAMOND, DIAMOND, DIAMOND])
    const [register, remove, add] = decodeAll(batch.calldatas)
    expect(register?.functionName).toBe('registerPeripheryContract')
    expect(register?.args).toEqual(['TokenWrapper', NEW_WRAPPER])
    expect(remove?.functionName).toBe('batchSetContractSelectorWhitelist')
    expect(remove?.args).toEqual([
      [OLD_WRAPPER, OLD_WRAPPER],
      [WRAP_DEPOSIT, WRAP_WITHDRAW],
      false,
    ])
    expect(add?.functionName).toBe('batchSetContractSelectorWhitelist')
    expect(add?.args[2]).toBe(true)
    expect(add?.args[0]).toEqual([NEW_WRAPPER, NEW_WRAPPER])
    expect([...(add?.args[1] ?? [])].sort()).toEqual(
      [WRAP_DEPOSIT, WRAP_WITHDRAW].sort()
    )
  })

  it('refuses before building anything while whitelist.json predates the deploy', () => {
    expect(() =>
      build(wrapperConfig(OLD_WRAPPER, [WRAP_WITHDRAW, WRAP_DEPOSIT]))
    ).toThrow(/update config\/whitelist\.json first/)
  })

  it('carries only the registration when the chain already allowlists the address', () => {
    const batch = build(
      wrapperConfig(NEW_WRAPPER, [WRAP_WITHDRAW, WRAP_DEPOSIT]),
      {
        actual: [
          pair(NEW_WRAPPER, WRAP_DEPOSIT),
          pair(NEW_WRAPPER, WRAP_WITHDRAW),
          pair(OTHER_PERIPHERY, '0x27444dab'),
        ],
      }
    )
    expect(decodeAll(batch.calldatas).map((c) => c.functionName)).toEqual([
      'registerPeripheryContract',
    ])
  })

  it('refuses a registered address with no code rather than dropping its pairs', () => {
    expect(() =>
      build(wrapperConfig(NEW_WRAPPER, [WRAP_WITHDRAW, WRAP_DEPOSIT]), {
        codeless: [NEW_WRAPPER.toLowerCase()],
      })
    ).toThrow(/no code/)
  })

  it('drops a codeless unrelated target and reports it', () => {
    const batch = build(
      wrapperConfig(NEW_WRAPPER, [WRAP_WITHDRAW, WRAP_DEPOSIT]),
      {
        actual: [pair(OLD_WRAPPER, WRAP_DEPOSIT)],
        codeless: [OTHER_PERIPHERY.toLowerCase()],
      }
    )
    expect(batch.skippedCodeless).toEqual([OTHER_PERIPHERY.toLowerCase()])
    expect(batch.toAdd.map((p) => p.contract)).not.toContain(OTHER_PERIPHERY)
    expect(batch.toAdd.map((p) => p.contract)).toContain(NEW_WRAPPER)
  })

  it('registers several contracts in the one batch, registrations first', () => {
    const batch = buildPairedRegistrationBatch({
      network: 'fuse',
      diamond: DIAMOND,
      registrations: [
        { name: 'TokenWrapper', address: NEW_WRAPPER, required },
        {
          name: 'OutputValidator',
          address: OTHER_PERIPHERY,
          required: ['0x27444dab'],
        },
      ],
      desired: desiredPairs(
        wrapperConfig(NEW_WRAPPER, [WRAP_WITHDRAW, WRAP_DEPOSIT]),
        'fuse'
      ),
      actual: [],
      codeless: new Set(),
    })
    const names = decodeAll(batch.calldatas).map((c) => c.functionName)
    expect(names).toEqual([
      'registerPeripheryContract',
      'registerPeripheryContract',
      'batchSetContractSelectorWhitelist',
    ])
  })

  it('refuses a batch above the combined-proposal cap', () => {
    const many = Array.from({ length: 301 }, (_, i) => ({
      address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
      selectors: [{ selector: SWAP }],
    }))
    const config: IWhitelistConfig = {
      PERIPHERY: {
        fuse: [
          ...many,
          {
            address: NEW_WRAPPER,
            selectors: [
              { selector: WRAP_DEPOSIT },
              { selector: WRAP_WITHDRAW },
            ],
          },
        ],
      },
    }
    expect(() => build(config, { actual: [] })).toThrow(/combined-proposal cap/)
  })

  it('refuses an empty registration list', () => {
    expect(() =>
      buildPairedRegistrationBatch({
        network: 'fuse',
        diamond: DIAMOND,
        registrations: [],
        desired: [],
        actual: [],
        codeless: new Set(),
      })
    ).toThrow(/no registration/)
  })
})

describe('desiredPairs with a network normaliser', () => {
  it('uses the normaliser in place of the EVM checksum', () => {
    const seen: string[] = []
    const out = desiredPairs(
      { PERIPHERY: { tron: [{ address: 'TBfUq', selectors: [] }] } },
      'tron',
      (raw) => {
        seen.push(raw)
        return NEW_WRAPPER
      }
    )
    expect(seen).toEqual(['TBfUq'])
    expect(out).toEqual([{ contract: NEW_WRAPPER, selector: APPROVE_TO_ONLY }])
  })
})
