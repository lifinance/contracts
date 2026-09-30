/**
 * The Tron registration pass: a diamond-called contract is proposed in its own
 * timelock batch with its allowlist writes, every other name alone, and any
 * refusal lands before anything is proposed.
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

import type { IPeripheryRouteConfig } from '../../tasks/proposePeripheryWithWhitelist'

import {
  proposeTronPeripheryRegistrations,
  tronHasCode,
  type ITronPeripheryRegistrationDeps,
} from './propose-periphery-registrations'

// Stand-ins for base58: the injected toEvm maps each to a fixed 20-byte address.
const TRON = {
  diamond: 'T_DIAMOND',
  newWrapper: 'T_NEW_WRAPPER',
  oldWrapper: 'T_OLD_WRAPPER',
  newGasZip: 'T_NEW_GASZIP',
  feeCollector: 'T_FEE_COLLECTOR',
  lda: 'T_LDA',
} as const
const EVM = {
  T_DIAMOND: getAddress('0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'),
  T_NEW_WRAPPER: getAddress('0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2'),
  T_OLD_WRAPPER: getAddress('0xc3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3'),
  T_NEW_GASZIP: getAddress('0xf6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6'),
  T_FEE_COLLECTOR: getAddress('0xd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4'),
  T_LDA: getAddress('0xe5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5'),
} as const
const DEPOSIT = '0xd0e30db0' as Hex
const WITHDRAW = '0x3ccfd60b' as Hex
const GASZIP = '0x8b71ae6c' as Hex

const routeConfig: IPeripheryRouteConfig = {
  whitelistPeripheryFunctions: {
    TokenWrapper: [
      { selector: DEPOSIT, signature: 'deposit()' },
      { selector: WITHDRAW, signature: 'withdraw()' },
    ],
    GasZipPeriphery: [{ selector: GASZIP, signature: 'a()' }],
    LiFiDEXAggregator: [{ selector: '0x2646478b', signature: 'x()' }],
  },
  whitelistPeripheryNetworks: { LiFiDEXAggregator: ['lens'] },
}

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
    registered?: Record<string, Address>
    /** As TronWeb returns them, keyed by the EVM address. */
    selectors?: Record<string, unknown[]>
    pairWithWhitelist?: boolean
    codeless?: Address[]
    unreadable?: string
  } = {}
) => {
  const proposals: IProposal[] = []
  const recorded: string[] = []
  const errors: string[] = []
  const reads: string[] = []
  const deps: ITronPeripheryRegistrationDeps = {
    network: 'tron',
    diamond: TRON.diamond,
    pairWithWhitelist: options.pairWithWhitelist ?? true,
    routeConfig,
    toEvm: (address) => {
      const evm = (EVM as Record<string, Address | undefined>)[address]
      if (!evm) throw new Error(`fixture: no address for ${address}`)
      return evm
    },
    readRegistered: async (name) => {
      if (options.unreadable === name) throw new Error('429 forever')
      return options.registered?.[name]
    },
    readWhitelistedSelectors: async (contract) => {
      reads.push(contract)
      return options.selectors?.[contract] ?? []
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
  return { deps, proposals, recorded, errors, reads }
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

const replacing = {
  registered: { TokenWrapper: EVM[TRON.oldWrapper] as Address },
  // TronWeb hands bytes4 back without the prefix and in upper case
  selectors: { [EVM[TRON.oldWrapper]]: ['D0E30DB0', '3CCFD60B'] },
}

describe('proposeTronPeripheryRegistrations', () => {
  it('records nothing as pending on a dry run', async () => {
    const h = harness(replacing)
    h.deps.dryRun = true
    await proposeTronPeripheryRegistrations(
      [
        { name: 'TokenWrapper', address: TRON.newWrapper },
        { name: 'FeeCollector', address: TRON.feeCollector },
      ],
      h.deps
    )
    expect(h.proposals).toHaveLength(2)
    expect(h.recorded).toEqual([])
  })

  it('proposes a TokenWrapper replacement with its own whitelist writes in one batch', async () => {
    const h = harness(replacing)
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
    // only matched once the TronWeb selectors are normalised
    expect(remove?.args).toEqual([
      [EVM[TRON.oldWrapper], EVM[TRON.oldWrapper]],
      [DEPOSIT, WITHDRAW],
      false,
    ])
    expect(add?.args).toEqual([
      [EVM[TRON.newWrapper], EVM[TRON.newWrapper]],
      [DEPOSIT, WITHDRAW],
      true,
    ])
    expect(h.recorded).toEqual([`TokenWrapper@${TRON.newWrapper}`])
  })

  it('refuses before any proposal when TronWeb returns a selector that is not four bytes', async () => {
    const h = harness({
      ...replacing,
      selectors: { [EVM[TRON.oldWrapper]]: ['3ccfd6'] },
    })
    await expectRejects(
      proposeTronPeripheryRegistrations(
        [{ name: 'TokenWrapper', address: TRON.newWrapper }],
        h.deps
      ),
      /could not read the chain state of TokenWrapper/
    )
    expect(h.proposals).toEqual([])
  })

  it('gives two registrations on one network a batch each, holding only its own pairs', async () => {
    const h = harness(replacing)
    await proposeTronPeripheryRegistrations(
      [
        { name: 'TokenWrapper', address: TRON.newWrapper },
        { name: 'GasZipPeriphery', address: TRON.newGasZip },
      ],
      h.deps
    )
    expect(h.proposals).toHaveLength(2)
    const addresses = (proposal: IProposal | undefined) =>
      new Set(
        (proposal?.calls ?? [])
          .filter((c) => c.functionName === 'batchSetContractSelectorWhitelist')
          .flatMap((c) => c.args[0] as readonly Address[])
      )
    expect(addresses(h.proposals[0])).toEqual(
      new Set([EVM[TRON.oldWrapper], EVM[TRON.newWrapper]])
    )
    expect(addresses(h.proposals[1])).toEqual(new Set([EVM[TRON.newGasZip]]))
  })

  it('refuses the whole pass before any proposal when a registered address has no code', async () => {
    const h = harness({ codeless: [EVM[TRON.newWrapper] as Address] })
    await expectRejects(
      proposeTronPeripheryRegistrations(
        [
          { name: 'FeeCollector', address: TRON.feeCollector },
          { name: 'TokenWrapper', address: TRON.newWrapper },
        ],
        h.deps
      ),
      /no code[\s\S]*nothing was proposed/
    )
    // FeeCollector alone would be proposed; the refusal must stop it too
    expect(h.proposals).toEqual([])
    expect(h.recorded).toEqual([])
  })

  it('refuses a 2-byte stub and a 23-byte delegation as LibAsset.isContract does', async () => {
    const bytecode: Record<string, unknown> = {
      [EVM[TRON.feeCollector]]: `${'60'.repeat(24)}`,
      [EVM[TRON.newWrapper]]: '6080',
      [EVM[TRON.newGasZip]]: `ef0100${'ab'.repeat(20)}`,
    }
    const hasCode = tronHasCode(async (address) => bytecode[address])
    expect(await hasCode(EVM[TRON.feeCollector])).toBe(true)
    for (const [name, address] of [
      ['TokenWrapper', TRON.newWrapper],
      ['GasZipPeriphery', TRON.newGasZip],
    ] as const) {
      const h = harness()
      h.deps.hasCode = hasCode
      await expectRejects(
        proposeTronPeripheryRegistrations(
          [
            { name: 'FeeCollector', address: TRON.feeCollector },
            { name, address },
          ],
          h.deps
        ),
        new RegExp(`${name} .* has no code`)
      )
      expect(h.proposals).toEqual([])
    }
    expect(await tronHasCode(async () => undefined)(EVM[TRON.lda])).toBe(false)
  })

  it('refuses before any proposal when a plain registration has no code', async () => {
    const h = harness({ codeless: [EVM[TRON.feeCollector] as Address] })
    await expectRejects(
      proposeTronPeripheryRegistrations(
        [
          { name: 'TokenWrapper', address: TRON.newWrapper },
          { name: 'FeeCollector', address: TRON.feeCollector },
        ],
        h.deps
      ),
      /FeeCollector .* has no code/
    )
    expect(h.proposals).toEqual([])
  })

  it('refuses before any proposal when a registration cannot be read', async () => {
    const h = harness({ unreadable: 'FeeCollector' })
    await expectRejects(
      proposeTronPeripheryRegistrations(
        [
          { name: 'TokenWrapper', address: TRON.newWrapper },
          { name: 'FeeCollector', address: TRON.feeCollector },
        ],
        h.deps
      ),
      /could not read the registration of FeeCollector/
    )
    expect(h.proposals).toEqual([])
  })

  it('proposes a name outside whitelistPeripheryFunctions alone and reads no allowlist', async () => {
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
    expect(h.reads).toEqual([])
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

  it('does not pair on staging', async () => {
    const h = harness({ pairWithWhitelist: false })
    await proposeTronPeripheryRegistrations(
      [{ name: 'TokenWrapper', address: TRON.newWrapper }],
      h.deps
    )
    expect(h.proposals[0]?.calls.map((c) => c.functionName)).toEqual([
      'registerPeripheryContract',
    ])
  })

  it('counts a failed proposal and carries on', async () => {
    const h = harness()
    h.deps.propose = async () => {
      throw new Error('store down')
    }
    const outcome = await proposeTronPeripheryRegistrations(
      [
        { name: 'FeeCollector', address: TRON.feeCollector },
        { name: 'TokenWrapper', address: TRON.newWrapper },
      ],
      h.deps
    )
    expect(outcome.failed).toEqual(['FeeCollector', 'TokenWrapper'])
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
