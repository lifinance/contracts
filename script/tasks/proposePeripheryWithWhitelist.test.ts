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
import { getAddress, type Hex } from 'viem'

import {
  APPROVE_TO_ONLY,
  assertRegisteredAddressIsDesired,
  chunkPairs,
  desiredPairs,
  diffPairs,
  pairKey,
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
