/**
 * The Tron registration pass: a diamond-called contract is proposed in one
 * timelock batch with the whitelist writes, every other name alone, and a
 * whitelist file that does not cover a paired registration refuses the pass
 * before anything is proposed.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

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

import type {
  IPair,
  IPeripheryRouteConfig,
  IWhitelistConfig,
} from '../../tasks/proposePeripheryWithWhitelist'

import {
  proposeTronPeripheryRegistrations,
  type ITronPeripheryRegistrationDeps,
} from './propose-periphery-registrations'

// Stand-ins for base58: the injected toEvm maps each to a fixed 20-byte address.
const TRON = {
  diamond: 'T_DIAMOND',
  newWrapper: 'T_NEW_WRAPPER',
  oldWrapper: 'T_OLD_WRAPPER',
  feeCollector: 'T_FEE_COLLECTOR',
  lda: 'T_LDA',
} as const
const EVM = {
  T_DIAMOND: getAddress('0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'),
  T_NEW_WRAPPER: getAddress('0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2'),
  T_OLD_WRAPPER: getAddress('0xc3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3'),
  T_FEE_COLLECTOR: getAddress('0xd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4'),
  T_LDA: getAddress('0xe5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5'),
} as const
const DEPOSIT = '0xd0e30db0' as Hex
const WITHDRAW = '0x3ccfd60b' as Hex

const routeConfig: IPeripheryRouteConfig = {
  whitelistPeripheryFunctions: {
    TokenWrapper: [
      { selector: DEPOSIT, signature: 'deposit()' },
      { selector: WITHDRAW, signature: 'withdraw()' },
    ],
    LiFiDEXAggregator: [{ selector: '0x2646478b', signature: 'x()' }],
  },
  whitelistPeripheryNetworks: { LiFiDEXAggregator: ['lens'] },
}

const whitelistListing = (wrapper: string): IWhitelistConfig => ({
  PERIPHERY: {
    tron: [
      {
        address: wrapper,
        selectors: [{ selector: WITHDRAW }, { selector: DEPOSIT }],
      },
    ],
  },
})

const ABI = parseAbi([
  'function registerPeripheryContract(string,address)',
  'function batchSetContractSelectorWhitelist(address[],bytes4[],bool)',
])

interface IProposal {
  targets: string[]
  calls: ReturnType<typeof decodeFunctionData<typeof ABI>>[]
}

const harness = (
  options: {
    whitelist?: IWhitelistConfig
    actual?: IPair[]
    registered?: Record<string, Address>
    pairWithWhitelist?: boolean
    codeless?: Address[]
  } = {}
) => {
  const proposals: IProposal[] = []
  const recorded: string[] = []
  const errors: string[] = []
  let actualReads = 0
  const deps: ITronPeripheryRegistrationDeps = {
    network: 'tron',
    diamond: TRON.diamond,
    pairWithWhitelist: options.pairWithWhitelist ?? true,
    routeConfig,
    whitelistConfig: options.whitelist ?? whitelistListing(TRON.newWrapper),
    toEvm: (address) => {
      const evm = (EVM as Record<string, Address | undefined>)[address]
      if (!evm) throw new Error(`fixture: no address for ${address}`)
      return evm
    },
    readRegistered: async (name) => options.registered?.[name],
    readActualPairs: async () => {
      actualReads++
      return (
        options.actual ?? [
          { contract: EVM[TRON.oldWrapper] as Address, selector: DEPOSIT },
          { contract: EVM[TRON.oldWrapper] as Address, selector: WITHDRAW },
        ]
      )
    },
    hasCode: async (address) => !(options.codeless ?? []).includes(address),
    propose: async (targets, calldatas) => {
      proposals.push({
        targets,
        calls: calldatas.map((data) => decodeFunctionData({ abi: ABI, data })),
      })
    },
    recordPending: async (name, address) => {
      recorded.push(`${name}@${address}`)
    },
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: (message) => errors.push(message),
    },
  }
  return {
    deps,
    proposals,
    recorded,
    errors,
    actualReads: () => actualReads,
  }
}

async function expectRejects(promise: Promise<unknown>, match: RegExp) {
  try {
    await promise
  } catch (error) {
    expect(error instanceof Error ? error.message : String(error)).toMatch(
      match
    )
    return
  }
  throw new Error(`expected a rejection matching ${match}`)
}

describe('proposeTronPeripheryRegistrations', () => {
  it('proposes a TokenWrapper registration with its whitelist writes in one batch', async () => {
    const h = harness()
    await proposeTronPeripheryRegistrations(
      [{ name: 'TokenWrapper', address: TRON.newWrapper }],
      h.deps
    )
    expect(h.proposals).toHaveLength(1)
    const [proposal] = h.proposals
    expect(proposal?.targets).toEqual([
      TRON.diamond,
      TRON.diamond,
      TRON.diamond,
    ])
    const [register, remove, add] = proposal?.calls ?? []
    expect(register?.functionName).toBe('registerPeripheryContract')
    expect(register?.args).toEqual(['TokenWrapper', EVM[TRON.newWrapper]])
    expect(remove?.args?.[2]).toBe(false)
    expect(remove?.args?.[0]).toEqual([
      EVM[TRON.oldWrapper],
      EVM[TRON.oldWrapper],
    ])
    expect(add?.functionName).toBe('batchSetContractSelectorWhitelist')
    expect(add?.args?.[0]).toEqual([EVM[TRON.newWrapper], EVM[TRON.newWrapper]])
    expect([...((add?.args?.[1] as readonly Hex[]) ?? [])].sort()).toEqual(
      [DEPOSIT, WITHDRAW].sort()
    )
    expect(add?.args?.[2]).toBe(true)
    expect(h.recorded).toEqual([`TokenWrapper@${TRON.newWrapper}`])
  })

  it('refuses the whole pass before any proposal while whitelist.json lists the old address', async () => {
    const h = harness({ whitelist: whitelistListing(TRON.oldWrapper) })
    await expectRejects(
      proposeTronPeripheryRegistrations(
        [
          { name: 'FeeCollector', address: TRON.feeCollector },
          { name: 'TokenWrapper', address: TRON.newWrapper },
        ],
        h.deps
      ),
      /update config\/whitelist\.json first/
    )
    // FeeCollector alone would be proposed; the refusal must stop it too
    expect(h.proposals).toEqual([])
    expect(h.recorded).toEqual([])
  })

  it('refuses before any proposal when the registered address has no code', async () => {
    const h = harness({ codeless: [EVM[TRON.newWrapper] as Address] })
    await expectRejects(
      proposeTronPeripheryRegistrations(
        [
          { name: 'FeeCollector', address: TRON.feeCollector },
          { name: 'TokenWrapper', address: TRON.newWrapper },
        ],
        h.deps
      ),
      /no code/
    )
    expect(h.proposals).toEqual([])
  })

  it('proposes a name outside whitelistPeripheryFunctions alone, as before', async () => {
    const h = harness()
    await proposeTronPeripheryRegistrations(
      [{ name: 'FeeCollector', address: TRON.feeCollector }],
      h.deps
    )
    expect(h.proposals).toHaveLength(1)
    expect(h.proposals[0]?.targets).toEqual([TRON.diamond])
    expect(h.proposals[0]?.calls.map((c) => c.functionName)).toEqual([
      'registerPeripheryContract',
    ])
    // a plain registration never needs the allowlist
    expect(h.actualReads()).toBe(0)
  })

  it('proposes an out-of-scope LiFiDEXAggregator alone', async () => {
    const h = harness()
    await proposeTronPeripheryRegistrations(
      [{ name: 'LiFiDEXAggregator', address: TRON.lda }],
      h.deps
    )
    expect(h.proposals).toHaveLength(1)
    expect(h.proposals[0]?.calls.map((c) => c.functionName)).toEqual([
      'registerPeripheryContract',
    ])
  })

  it('keeps the plain and the paired registration in separate proposals', async () => {
    const h = harness()
    await proposeTronPeripheryRegistrations(
      [
        { name: 'FeeCollector', address: TRON.feeCollector },
        { name: 'TokenWrapper', address: TRON.newWrapper },
      ],
      h.deps
    )
    expect(h.proposals.map((p) => p.calls.map((c) => c.functionName))).toEqual([
      ['registerPeripheryContract'],
      [
        'registerPeripheryContract',
        'batchSetContractSelectorWhitelist',
        'batchSetContractSelectorWhitelist',
      ],
    ])
  })

  it('skips a contract already registered at its address', async () => {
    const h = harness({
      registered: { TokenWrapper: EVM[TRON.newWrapper] as Address },
    })
    const outcome = await proposeTronPeripheryRegistrations(
      [{ name: 'TokenWrapper', address: TRON.newWrapper }],
      h.deps
    )
    expect(h.proposals).toEqual([])
    expect(outcome.proposed).toEqual([])
  })

  it('does not pair on staging, where whitelist.json describes nothing', async () => {
    const h = harness({ pairWithWhitelist: false, whitelist: {} })
    await proposeTronPeripheryRegistrations(
      [{ name: 'TokenWrapper', address: TRON.newWrapper }],
      h.deps
    )
    expect(h.proposals[0]?.calls.map((c) => c.functionName)).toEqual([
      'registerPeripheryContract',
    ])
  })

  it('counts a failed plain proposal and carries on', async () => {
    const h = harness()
    h.deps.propose = async () => {
      throw new Error('store down')
    }
    const outcome = await proposeTronPeripheryRegistrations(
      [{ name: 'FeeCollector', address: TRON.feeCollector }],
      h.deps
    )
    expect(outcome.failed).toEqual(['FeeCollector'])
    expect(h.errors.join('\n')).toContain('store down')
  })
})

describe('deploy-and-register-periphery.ts registration placement', () => {
  const source = readFileSync(
    join(import.meta.dir, 'deploy-and-register-periphery.ts'),
    'utf8'
  )

  it('proposes registrations only through proposeTronPeripheryRegistrations', () => {
    expect(source).toMatch(/await proposeTronPeripheryRegistrations\(/)
    // the old inline route encoded the registration itself; any encoder left
    // in the script is a registration that skips the pairing
    expect(source).not.toMatch(/registerPeripheryContract/)
    expect(source).not.toMatch(/encodeFunctionData/)
  })

  it('pairs on production only', () => {
    expect(source).toMatch(
      /pairWithWhitelist:\s*environment === EnvironmentEnum\.production/
    )
  })
})
