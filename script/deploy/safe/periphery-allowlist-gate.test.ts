/**
 * Gate W: a registration of a diamond-called periphery contract is refused
 * unless its selectors are on the diamond's allowlist once the proposal runs.
 */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import {
  encodeFunctionData,
  getAddress,
  parseAbi,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem'

import globalConfig from '../../../config/global.json'
import { normalizeAddressForNetwork } from '../../utils/normalizeAddressStringForViem'
import { DIAMOND_CUT_ABI } from '../shared/constants'

import { createCheckLedger, gateLabel, recordCheck } from './check-ledger'
import {
  ALL_GATE_DEFINITIONS,
  CONFIRM_CHECK_DEFINITIONS,
  PERIPHERY_ALLOWLIST_CHECK,
  PERIPHERY_ALLOWLIST_CHECK_ID,
  peripheryAllowlistCheckResult,
} from './confirm-check-registry'
import {
  blockedPeripheryAllowlist,
  evaluatePeripheryAllowlist,
  PERIPHERY_ALLOWLIST_GATE_HEADING,
  peripheryAllowlistRemedy,
  peripheryFunctionsFromConfig,
  peripheryNetworksFromConfig,
  readAllowlistThrough,
  renderPeripheryAllowlistLines,
  renderPeripheryAllowlistRefusal,
  type IPeripheryAllowlistDeps,
  type IPeripheryAllowlistVerdict,
} from './periphery-allowlist-gate'
import { renderCheckLedger } from './render-check-ledger'
import {
  TIMELOCK_SCHEDULE_ABI,
  TIMELOCK_SCHEDULE_BATCH_ABI,
} from './timelock-abi'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' as Address
const OTHER_DIAMOND = '0xF3B20515d9B193531c48E47c18aF16d1e5d28f9a' as Address
const TIMELOCK = '0x5604A94A3438C3074EFFF803fab14B7244fe4E29' as Address
// real TokenWrapper address
const TOKEN_WRAPPER = '0x31F6b192Ec4a7eEF00E09ee17c36ca518c65bbfe' as Address
const SAFE = '0x00000000000000000000000000000000000005a1' as Address
const ZERO = '0x0000000000000000000000000000000000000000' as Address
const DEPOSIT = '0xd0e30db0' as Hex
const WITHDRAW = '0x3ccfd60b' as Hex

const ABI = parseAbi([
  'function registerPeripheryContract(string,address)',
  'function setContractSelectorWhitelist(address,bytes4,bool)',
  'function batchSetContractSelectorWhitelist(address[],bytes4[],bool)',
  'function mysteryEnvelope(bytes)',
])

const register = (name: string, address: Address = TOKEN_WRAPPER): Hex =>
  encodeFunctionData({
    abi: ABI,
    functionName: 'registerPeripheryContract',
    args: [name, address],
  })

const batchWhitelist = (
  contract: Address,
  selectors: readonly Hex[],
  whitelisted = true
): Hex =>
  encodeFunctionData({
    abi: ABI,
    functionName: 'batchSetContractSelectorWhitelist',
    args: [selectors.map(() => contract), [...selectors], whitelisted],
  })

const singleWhitelist = (
  contract: Address,
  selector: Hex,
  whitelisted = true
): Hex =>
  encodeFunctionData({
    abi: ABI,
    functionName: 'setContractSelectorWhitelist',
    args: [contract, selector, whitelisted],
  })

const scheduleBatch = (
  payloads: readonly Hex[],
  targets: readonly Address[] = payloads.map(() => DIAMOND)
): Hex =>
  encodeFunctionData({
    abi: TIMELOCK_SCHEDULE_BATCH_ABI,
    functionName: 'scheduleBatch',
    args: [
      [...targets],
      payloads.map(() => 0n),
      [...payloads],
      `0x${'00'.repeat(32)}`,
      `0x${'11'.repeat(32)}`,
      10800n,
    ],
  })

const schedule = (payload: Hex, target: Address = DIAMOND): Hex =>
  encodeFunctionData({
    abi: TIMELOCK_SCHEDULE_ABI,
    functionName: 'schedule',
    args: [
      target,
      0n,
      payload,
      `0x${'00'.repeat(32)}`,
      `0x${'11'.repeat(32)}`,
      10800n,
    ],
  })

const PERIPHERY_FUNCTIONS = peripheryFunctionsFromConfig(
  globalConfig.whitelistPeripheryFunctions
)
const PERIPHERY_NETWORKS = peripheryNetworksFromConfig(
  globalConfig.whitelistPeripheryNetworks,
  PERIPHERY_FUNCTIONS
)

/** A reader that answers from a fixed table and counts what it was asked. */
const chain = (
  allowlisted: readonly Hex[] | Error = []
): IPeripheryAllowlistDeps & { reads: string[] } => {
  const reads: string[] = []
  return {
    reads,
    peripheryFunctions: PERIPHERY_FUNCTIONS,
    peripheryNetworks: PERIPHERY_NETWORKS,
    readWhitelistedSelectors: async (diamond, contract) => {
      reads.push(`${diamond}:${contract}`)
      if (allowlisted instanceof Error) throw allowlisted
      return allowlisted
    },
  }
}

const viaTimelock = (data: Hex, network = 'gnosis') => ({
  calldatas: [data],
  targets: [TIMELOCK],
  caller: SAFE,
  network,
})
const direct = (data: Hex, network = 'gnosis') => ({
  calldatas: [data],
  targets: [DIAMOND],
  caller: SAFE,
  network,
})

const rowOf = (verdict: IPeripheryAllowlistVerdict, network = 'gnosis') =>
  peripheryAllowlistCheckResult(verdict, network)

describe('peripheryFunctionsFromConfig', () => {
  it('reads the selectors main lists for a diamond-called periphery', () => {
    expect(
      PERIPHERY_FUNCTIONS.get('TokenWrapper')?.map((one) => one.selector)
    ).toEqual([DEPOSIT, WITHDRAW])
    expect(PERIPHERY_FUNCTIONS.has('Executor')).toBe(false)
  })

  it('refuses an entry whose selector is not four bytes', () => {
    expect(() =>
      peripheryFunctionsFromConfig({
        TokenWrapper: [{ selector: '0xd0e3', signature: 'deposit()' }],
      })
    ).toThrow(/TokenWrapper/u)
  })

  it('refuses a name that lists no selector, which would clear vacuously', () => {
    expect(() => peripheryFunctionsFromConfig({ TokenWrapper: [] })).toThrow(
      /TokenWrapper/u
    )
  })
})

describe('evaluatePeripheryAllowlist — the gnosis op 38 shape', () => {
  it('refuses a registration whose allowlist the chain reports empty', async () => {
    const deps = chain([])
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(scheduleBatch([register('TokenWrapper')])),
      deps
    )

    expect(verdict.cleared).toBe(false)
    expect(verdict.findings.map((finding) => finding.status)).toEqual([
      'missing',
    ])
    expect(verdict.findings[0]?.missing).toEqual([DEPOSIT, WITHDRAW])
    expect(deps.reads).toEqual([`${DIAMOND}:${TOKEN_WRAPPER}`])

    const row = rowOf(verdict)
    expect(row.status).toBe('fail')
    expect(row.anchor).toBe('A-CHAIN')
    expect(row.expected).toContain(`${DEPOSIT} deposit()`)
    expect(row.expected).toContain(`${WITHDRAW} withdraw()`)
    expect(row.expected).toContain(TOKEN_WRAPPER)
    expect(row.actual).toContain('observed none')
    expect(row.detail).toContain(
      'propose the whitelist sync with, or before, this registration'
    )
  })

  it('passes the same registration once the chain holds both selectors', async () => {
    const deps = chain([WITHDRAW, DEPOSIT])
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(scheduleBatch([register('TokenWrapper')])),
      deps
    )

    expect(verdict.cleared).toBe(true)
    expect(verdict.findings.map((finding) => finding.status)).toEqual([
      'allowlisted',
    ])
    expect(deps.reads).toHaveLength(1)
    const row = rowOf(verdict)
    expect(row.status).toBe('pass')
    expect(row.anchor).toBe('A-CHAIN')
    expect(row.actual).not.toContain('observed none')
    expect(row.actual).toContain('TokenWrapper')
  })

  it('refuses when the chain holds only one of the two', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(scheduleBatch([register('TokenWrapper')])),
      chain([DEPOSIT])
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings[0]?.missing).toEqual([WITHDRAW])
    expect(rowOf(verdict).actual).toContain(`observed ${DEPOSIT}`)
  })

  it('compares selectors case-insensitively', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(scheduleBatch([register('TokenWrapper')])),
      chain(['0xD0E30DB0', '0x3CCFD60B'] as Hex[])
    )
    expect(verdict.cleared).toBe(true)
  })
})

describe('evaluatePeripheryAllowlist — paired in the same batch', () => {
  it('passes without a read when the batch allowlists every selector', async () => {
    const deps = chain(new Error('must not be read'))
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(
        scheduleBatch([
          register('TokenWrapper'),
          batchWhitelist(TOKEN_WRAPPER, [DEPOSIT, WITHDRAW]),
        ])
      ),
      deps
    )

    expect(verdict.cleared).toBe(true)
    expect(verdict.findings.map((finding) => finding.status)).toEqual([
      'paired',
    ])
    expect(deps.reads).toEqual([])
    const row = rowOf(verdict)
    expect(row.status).toBe('pass')
    expect(row.anchor).toBe('A-LOCAL')
  })

  it('pairs through the single-pair setter too, and in either order', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(
        scheduleBatch([
          singleWhitelist(TOKEN_WRAPPER, WITHDRAW),
          register('TokenWrapper'),
          singleWhitelist(TOKEN_WRAPPER, DEPOSIT),
        ])
      ),
      chain(new Error('must not be read'))
    )
    expect(verdict.cleared).toBe(true)
  })

  it('refuses a batch that allowlists only one selector over an empty chain', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(
        scheduleBatch([
          register('TokenWrapper'),
          batchWhitelist(TOKEN_WRAPPER, [DEPOSIT]),
        ])
      ),
      chain([])
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings[0]?.missing).toEqual([WITHDRAW])
  })

  it('combines a partial batch with what the chain already holds', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(
        scheduleBatch([
          register('TokenWrapper'),
          batchWhitelist(TOKEN_WRAPPER, [DEPOSIT]),
        ])
      ),
      chain([WITHDRAW])
    )
    expect(verdict.cleared).toBe(true)
    expect(verdict.findings[0]?.status).toBe('paired')
    expect(rowOf(verdict).anchor).toBe('A-CHAIN')
  })

  it('refuses a batch that removes a selector the chain holds', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(
        scheduleBatch([
          register('TokenWrapper'),
          batchWhitelist(TOKEN_WRAPPER, [WITHDRAW], false),
        ])
      ),
      chain([DEPOSIT, WITHDRAW])
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings[0]?.missing).toEqual([WITHDRAW])
  })

  it('refuses a single-pair removal of a selector the chain holds', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(
        scheduleBatch([
          register('TokenWrapper'),
          singleWhitelist(TOKEN_WRAPPER, DEPOSIT, false),
        ])
      ),
      chain([DEPOSIT, WITHDRAW])
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings[0]?.missing).toEqual([DEPOSIT])
  })

  it('refuses beside a whitelist change it could not read, which could be a removal', async () => {
    const garbled = `${toFunctionSelector(
      'setContractSelectorWhitelist(address,bytes4,bool)'
    )}00ff` as Hex
    const withRegistration = await evaluatePeripheryAllowlist(
      viaTimelock(scheduleBatch([register('TokenWrapper'), garbled])),
      chain([DEPOSIT, WITHDRAW])
    )
    expect(withRegistration.cleared).toBe(false)
    expect(withRegistration.unreadable).toHaveLength(1)

    const alone = await evaluatePeripheryAllowlist(
      viaTimelock(scheduleBatch([garbled])),
      chain([DEPOSIT, WITHDRAW])
    )
    expect(alone.cleared).toBe(true)
    expect(alone.unreadable).toEqual([])
  })

  it('lets a later write in the batch supersede an earlier one', async () => {
    const readd = await evaluatePeripheryAllowlist(
      viaTimelock(
        scheduleBatch([
          register('TokenWrapper'),
          singleWhitelist(TOKEN_WRAPPER, DEPOSIT, false),
          singleWhitelist(TOKEN_WRAPPER, DEPOSIT, true),
        ])
      ),
      chain([WITHDRAW])
    )
    expect(readd.cleared).toBe(true)

    const remove = await evaluatePeripheryAllowlist(
      viaTimelock(
        scheduleBatch([
          register('TokenWrapper'),
          singleWhitelist(TOKEN_WRAPPER, DEPOSIT, true),
          singleWhitelist(TOKEN_WRAPPER, DEPOSIT, false),
        ])
      ),
      chain([WITHDRAW])
    )
    expect(remove.cleared).toBe(false)
  })

  it('does not pair a whitelist op aimed at a different diamond', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(
        scheduleBatch(
          [
            register('TokenWrapper'),
            batchWhitelist(TOKEN_WRAPPER, [DEPOSIT, WITHDRAW]),
          ],
          [DIAMOND, OTHER_DIAMOND]
        )
      ),
      chain([])
    )
    expect(verdict.cleared).toBe(false)
  })

  it('does not pair a whitelist op for a different contract', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(
        scheduleBatch([
          register('TokenWrapper'),
          batchWhitelist(OTHER_DIAMOND, [DEPOSIT, WITHDRAW]),
        ])
      ),
      chain([])
    )
    expect(verdict.cleared).toBe(false)
  })
})

describe('evaluatePeripheryAllowlist — envelopes', () => {
  it('grades a registration inside the singular timelock schedule', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(schedule(register('TokenWrapper'))),
      chain([])
    )
    expect(verdict.findings.map((finding) => finding.status)).toEqual([
      'missing',
    ])
    expect(verdict.cleared).toBe(false)
  })

  it('grades a registration sent to the diamond directly', async () => {
    const deps = chain([])
    const verdict = await evaluatePeripheryAllowlist(
      direct(register('TokenWrapper')),
      deps
    )
    expect(verdict.cleared).toBe(false)
    expect(deps.reads).toEqual([`${DIAMOND}:${TOKEN_WRAPPER}`])
  })

  it('grades a registration nested two envelopes deep', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(
        scheduleBatch([schedule(register('TokenWrapper'))], [TIMELOCK])
      ),
      chain([])
    )
    expect(verdict.findings.map((finding) => finding.status)).toEqual([
      'missing',
    ])
  })

  it('refuses a registration hidden in an envelope nothing opens', async () => {
    const hidden = encodeFunctionData({
      abi: ABI,
      functionName: 'mysteryEnvelope',
      args: [register('TokenWrapper')],
    })
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(scheduleBatch([hidden])),
      chain([DEPOSIT, WITHDRAW])
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.unreadable).toHaveLength(1)
    const row = rowOf(verdict)
    expect(row.status).toBe('error')
    expect(row.anchor).toBe('A-UNRESOLVED')
  })

  it('stands down on an unopened envelope that carries no registration', async () => {
    const opaque = encodeFunctionData({
      abi: ABI,
      functionName: 'mysteryEnvelope',
      args: ['0xdeadbeef'],
    })
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(scheduleBatch([opaque])),
      chain([])
    )
    expect(verdict.cleared).toBe(true)
    expect(verdict.unreadable).toEqual([])
    expect(rowOf(verdict).status).toBe('not-applicable')
  })

  it('refuses a truncated schedule envelope that carries a registration', async () => {
    const whole = scheduleBatch([register('TokenWrapper')])
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(whole.slice(0, whole.length - 64) as Hex),
      chain([DEPOSIT, WITHDRAW])
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.unreadable).toHaveLength(1)
  })

  it('refuses a registration whose arguments do not decode', async () => {
    const selector = toFunctionSelector(
      'registerPeripheryContract(string,address)'
    )
    const verdict = await evaluatePeripheryAllowlist(
      direct(`${selector}00ff` as Hex),
      chain([DEPOSIT, WITHDRAW])
    )
    expect(verdict.cleared).toBe(false)
    expect(rowOf(verdict).status).toBe('error')
  })
})

describe('evaluatePeripheryAllowlist — out of scope', () => {
  it('reads nothing for a periphery the diamond never calls', async () => {
    const deps = chain(new Error('must not be read'))
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(scheduleBatch([register('Executor')])),
      deps
    )
    expect(verdict.cleared).toBe(true)
    expect(verdict.findings.map((finding) => finding.status)).toEqual([
      'not-diamond-called',
    ])
    expect(deps.reads).toEqual([])
    const row = rowOf(verdict)
    expect(row.status).toBe('not-applicable')
    expect(row.actual).toContain('Executor')
  })

  it.each(['constructor', 'toString', '__proto__', 'tokenwrapper'])(
    'treats the name %p as not diamond-called',
    async (name) => {
      const deps = chain(new Error('must not be read'))
      const verdict = await evaluatePeripheryAllowlist(
        direct(register(name)),
        deps
      )
      expect(verdict.findings[0]?.status).toBe('not-diamond-called')
      expect(verdict.cleared).toBe(true)
    }
  )

  it('reads nothing for a registration that clears the name', async () => {
    const deps = chain(new Error('must not be read'))
    const verdict = await evaluatePeripheryAllowlist(
      direct(register('TokenWrapper', ZERO)),
      deps
    )
    expect(verdict.findings[0]?.status).toBe('deregistration')
    expect(verdict.cleared).toBe(true)
  })

  it('is not applicable to a proposal that registers nothing', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(scheduleBatch([batchWhitelist(TOKEN_WRAPPER, [DEPOSIT])])),
      chain(new Error('must not be read'))
    )
    expect(verdict.findings).toEqual([])
    expect(verdict.cleared).toBe(true)
    expect(rowOf(verdict).status).toBe('not-applicable')
  })

  it('still grades the whitelisted registration beside an out-of-scope one', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(
        scheduleBatch([register('Executor'), register('TokenWrapper')])
      ),
      chain([])
    )
    expect(verdict.cleared).toBe(false)
    expect(rowOf(verdict).status).toBe('fail')
  })
})

describe('evaluatePeripheryAllowlist — reads that fail', () => {
  it('is unverified, never a pass, when the allowlist read throws', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(scheduleBatch([register('TokenWrapper')])),
      chain(new Error('rpc exploded'))
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings[0]?.status).toBe('read-failed')
    const row = rowOf(verdict)
    expect(row.status).toBe('error')
    expect(row.anchor).toBe('A-UNRESOLVED')
    expect(row.actual).toContain('rpc exploded')
  })

  it('is unverified when the diamond the registration is sent to is unknown', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      {
        calldatas: [register('TokenWrapper')],
        targets: [],
        caller: SAFE,
        network: 'gnosis',
      },
      chain([DEPOSIT, WITHDRAW])
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings[0]?.status).toBe('read-failed')
  })

  it('a verdict for an evaluation that threw blocks', () => {
    const verdict = blockedPeripheryAllowlist('gnosis', 'config unreadable')
    expect(verdict.cleared).toBe(false)
    expect(rowOf(verdict).status).toBe('error')
  })

  it('a verdict nobody produced is an unverified row', () => {
    const row = peripheryAllowlistCheckResult(undefined, 'gnosis')
    expect(row.status).toBe('error')
    expect(row.anchor).toBe('A-UNRESOLVED')
  })
})

describe('gate W verdict and row agree', () => {
  const cases: [string, Hex, readonly Hex[] | Error][] = [
    ['missing', scheduleBatch([register('TokenWrapper')]), []],
    [
      'allowlisted',
      scheduleBatch([register('TokenWrapper')]),
      [DEPOSIT, WITHDRAW],
    ],
    ['read failed', scheduleBatch([register('TokenWrapper')]), new Error('x')],
    ['out of scope', scheduleBatch([register('Executor')]), []],
    [
      'nothing registered',
      scheduleBatch([singleWhitelist(TOKEN_WRAPPER, DEPOSIT)]),
      [],
    ],
  ]

  it.each(cases)(
    '%s: cleared iff the row does not block',
    async (_, data, onChain) => {
      const verdict = await evaluatePeripheryAllowlist(
        viaTimelock(data),
        chain(onChain)
      )
      expect(verdict.cleared).toBe(
        ['pass', 'not-applicable'].includes(rowOf(verdict).status)
      )
    }
  )
})

describe('gate W rendering', () => {
  it('names the gate by the label the manifest lists it under', () => {
    expect(PERIPHERY_ALLOWLIST_GATE_HEADING).toBe(
      gateLabel(PERIPHERY_ALLOWLIST_CHECK)
    )
  })

  it('is on the run roster under its own letter', () => {
    expect(PERIPHERY_ALLOWLIST_CHECK.gate).toBe('W')
    expect(PERIPHERY_ALLOWLIST_CHECK.checkClass).toBe('integrity')
    expect(CONFIRM_CHECK_DEFINITIONS.map((one) => one.checkId)).toContain(
      PERIPHERY_ALLOWLIST_CHECK_ID
    )
    expect(
      ALL_GATE_DEFINITIONS.filter((one) => one.gate === 'W').map(
        (one) => one.checkId
      )
    ).toEqual([PERIPHERY_ALLOWLIST_CHECK_ID])
  })

  it('refuses under the gate heading and says nothing was signed', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(scheduleBatch([register('TokenWrapper')])),
      chain([])
    )
    const refusal = renderPeripheryAllowlistRefusal(verdict).join('\n')
    expect(refusal).toContain(PERIPHERY_ALLOWLIST_GATE_HEADING)
    expect(refusal).toContain('NOT SIGNING OR EXECUTING')
  })

  it('prints the expected and observed allowlist under the row', async () => {
    const missing = await evaluatePeripheryAllowlist(
      viaTimelock(scheduleBatch([register('TokenWrapper')])),
      chain([])
    )
    const lines = renderPeripheryAllowlistLines(missing).join('\n')
    expect(lines).toContain(PERIPHERY_ALLOWLIST_GATE_HEADING)
    expect(lines).toContain(TOKEN_WRAPPER)
    expect(lines).toContain('observed none')
    expect(lines).toContain('proposePeripheryWithWhitelist.ts')

    const allowlisted = await evaluatePeripheryAllowlist(
      viaTimelock(scheduleBatch([register('TokenWrapper')])),
      chain([DEPOSIT, WITHDRAW])
    )
    const clean = renderPeripheryAllowlistLines(allowlisted).join('\n')
    expect(clean).toContain(PERIPHERY_ALLOWLIST_GATE_HEADING)
    expect(clean).toContain(TOKEN_WRAPPER)
    expect(clean).not.toContain('observed none')
  })

  it('prints nothing under the row for a proposal that registers nothing', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(scheduleBatch([singleWhitelist(TOKEN_WRAPPER, DEPOSIT)])),
      chain([])
    )
    expect(renderPeripheryAllowlistLines(verdict)).toEqual([])
  })

  it('is described in the signing document under the same label', () => {
    const doc = readFileSync(
      path.join(HERE, '../../../docs/MultisigSigningProcess.md'),
      'utf8'
    )
    expect(doc).toContain(PERIPHERY_ALLOWLIST_GATE_HEADING)
  })
})

const LDA_ADDRESS = getAddress('0x5e3cf1b6c8f4d2a0b9e7c3d1f2a4b6c8d0e2f4a6')
const LDA_SELECTORS = (PERIPHERY_FUNCTIONS.get('LiFiDEXAggregator') ?? []).map(
  (one) => one.selector
)

describe('evaluatePeripheryAllowlist — whitelistPeripheryNetworks', () => {
  it('clears a LiFiDEXAggregator registration on a network config does not whitelist it on', async () => {
    const deps = chain(new Error('must not be read'))
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(
        scheduleBatch([register('LiFiDEXAggregator', LDA_ADDRESS)]),
        'mainnet'
      ),
      deps
    )
    expect(verdict.findings.map((finding) => finding.status)).toEqual([
      'out-of-scope',
    ])
    expect(verdict.cleared).toBe(true)
    expect(deps.reads).toEqual([])
    const row = rowOf(verdict, 'mainnet')
    expect(row.status).toBe('not-applicable')
    expect(row.actual).toContain('LiFiDEXAggregator is out-of-scope')
    expect(renderPeripheryAllowlistLines(verdict).join('\n')).toContain(
      'not whitelisted on mainnet by config'
    )
  })

  it('still refuses LiFiDEXAggregator with an empty allowlist on a network config scopes it to', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(
        scheduleBatch([register('LiFiDEXAggregator', LDA_ADDRESS)]),
        'lens'
      ),
      chain([])
    )
    expect(verdict.findings.map((finding) => finding.status)).toEqual([
      'missing',
    ])
    expect(verdict.findings[0]?.missing).toEqual(LDA_SELECTORS)
    expect(verdict.cleared).toBe(false)
    expect(rowOf(verdict, 'lens').status).toBe('fail')
    expect(renderPeripheryAllowlistLines(verdict).join('\n')).not.toContain(
      'not whitelisted on'
    )
  })

  it('matches the network case-insensitively, as the whitelist sync does', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(
        scheduleBatch([register('LiFiDEXAggregator', LDA_ADDRESS)]),
        'LENS'
      ),
      chain([])
    )
    expect(verdict.findings[0]?.status).toBe('missing')
  })

  it('grades a name config does not scope on every network, mainnet included', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(scheduleBatch([register('TokenWrapper')]), 'mainnet'),
      chain([])
    )
    expect(verdict.findings[0]?.status).toBe('missing')
    expect(verdict.cleared).toBe(false)
  })

  it('refuses a scope map naming a contract whitelistPeripheryFunctions lacks', () => {
    expect(() =>
      peripheryNetworksFromConfig(
        { LiFiDexAggregator: ['lens'] },
        PERIPHERY_FUNCTIONS
      )
    ).toThrow(/LiFiDexAggregator/u)
    expect(() =>
      peripheryNetworksFromConfig(
        { LiFiDEXAggregator: 'lens' },
        PERIPHERY_FUNCTIONS
      )
    ).toThrow(/LiFiDEXAggregator/u)
    expect(() =>
      peripheryNetworksFromConfig(['lens'], PERIPHERY_FUNCTIONS)
    ).toThrow(/not an object/u)
  })

  it('scopes nothing when config carries no scope map', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(
        scheduleBatch([register('LiFiDEXAggregator', LDA_ADDRESS)]),
        'mainnet'
      ),
      {
        ...chain([]),
        peripheryNetworks: peripheryNetworksFromConfig(
          undefined,
          PERIPHERY_FUNCTIONS
        ),
      }
    )
    expect(verdict.findings[0]?.status).toBe('missing')
  })
})

const FACET = getAddress('0x7d1d53d1f2b7a3a5c0cf4e8f5b8f1c0b9b6e7a21')
const REGISTER_SELECTOR = toFunctionSelector(
  'registerPeripheryContract(string,address)'
)
const GET_PERIPHERY_SELECTOR = toFunctionSelector(
  'getPeripheryContract(string)'
)

const diamondCut = (
  init: Address,
  initCalldata: Hex,
  cuts: readonly {
    facetAddress: Address
    action: number
    functionSelectors: readonly Hex[]
  }[] = []
): Hex =>
  encodeFunctionData({
    abi: DIAMOND_CUT_ABI,
    functionName: 'diamondCut',
    args: [
      cuts.map((cut) => ({
        ...cut,
        functionSelectors: [...cut.functionSelectors],
      })),
      init,
      initCalldata,
    ],
  })

describe('evaluatePeripheryAllowlist — a diamondCut _init', () => {
  it.each([
    ['the diamond', DIAMOND],
    ['a facet', FACET],
  ])(
    'grades a registration delegatecalled through _init on %s',
    async (_, init) => {
      const deps = chain([])
      const verdict = await evaluatePeripheryAllowlist(
        viaTimelock(
          scheduleBatch([diamondCut(init, register('TokenWrapper'))])
        ),
        deps
      )
      expect(verdict.findings.map((finding) => finding.status)).toEqual([
        'missing',
      ])
      expect(verdict.findings[0]?.path).toContain('_init')
      expect(deps.reads).toEqual([`${DIAMOND}:${TOKEN_WRAPPER}`])
      expect(verdict.cleared).toBe(false)
    }
  )

  it('applies a whitelist removal carried in _init to the registration beside it', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(
        scheduleBatch([
          register('TokenWrapper'),
          diamondCut(DIAMOND, singleWhitelist(TOKEN_WRAPPER, DEPOSIT, false)),
        ])
      ),
      chain([DEPOSIT, WITHDRAW])
    )
    expect(verdict.findings[0]?.missing).toEqual([DEPOSIT])
    expect(verdict.cleared).toBe(false)
  })

  it('pairs a registration with a whitelist add carried in _init', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(
        scheduleBatch([
          diamondCut(
            DIAMOND,
            batchWhitelist(TOKEN_WRAPPER, [DEPOSIT, WITHDRAW])
          ),
          register('TokenWrapper'),
        ])
      ),
      chain(new Error('must not be read'))
    )
    expect(verdict.findings[0]?.status).toBe('paired')
    expect(verdict.cleared).toBe(true)
  })

  it.each([
    [
      'an _init that is not the diamond',
      diamondCut(FACET, batchWhitelist(TOKEN_WRAPPER, [DEPOSIT, WITHDRAW])),
    ],
    [
      'a diamond _init nested inside one that is not the diamond',
      diamondCut(
        FACET,
        diamondCut(DIAMOND, batchWhitelist(TOKEN_WRAPPER, [DEPOSIT, WITHDRAW]))
      ),
    ],
  ])(
    'does not pair a registration with a whitelist add in %s',
    async (_, cut) => {
      const deps = chain([])
      const verdict = await evaluatePeripheryAllowlist(
        viaTimelock(scheduleBatch([cut, register('TokenWrapper')])),
        deps
      )
      expect(verdict.findings.map((finding) => finding.status)).toEqual([
        'missing',
      ])
      expect(verdict.findings[0]?.missing).toEqual([DEPOSIT, WITHDRAW])
      expect(deps.reads).toEqual([`${DIAMOND}:${TOKEN_WRAPPER}`])
      expect(verdict.cleared).toBe(false)
    }
  )

  it('applies a whitelist removal carried in an _init that is not the diamond', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(
        scheduleBatch([
          register('TokenWrapper'),
          diamondCut(FACET, singleWhitelist(TOKEN_WRAPPER, DEPOSIT, false)),
        ])
      ),
      chain([DEPOSIT, WITHDRAW])
    )
    expect(verdict.findings[0]?.status).toBe('missing')
    expect(verdict.findings[0]?.missing).toEqual([DEPOSIT])
    expect(verdict.cleared).toBe(false)
  })

  it('grades a registration in the _init of a cut nested inside another _init', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      direct(diamondCut(DIAMOND, diamondCut(FACET, register('TokenWrapper')))),
      chain([])
    )
    expect(verdict.findings[0]?.status).toBe('missing')
  })

  it('refuses an _init whose calldata hides a registration in a call it does not open', async () => {
    const hidden = encodeFunctionData({
      abi: ABI,
      functionName: 'mysteryEnvelope',
      args: [register('TokenWrapper')],
    })
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(scheduleBatch([diamondCut(FACET, hidden)])),
      chain([DEPOSIT, WITHDRAW])
    )
    expect(verdict.unreadable).toHaveLength(1)
    expect(verdict.unreadable[0]).toContain('_init')
    expect(verdict.cleared).toBe(false)
  })

  it('stands down on a facet cut listing the registry selectors with no _init', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(
        scheduleBatch([
          diamondCut(ZERO, '0x', [
            {
              facetAddress: FACET,
              action: 0,
              functionSelectors: [REGISTER_SELECTOR, GET_PERIPHERY_SELECTOR],
            },
          ]),
        ])
      ),
      chain(new Error('must not be read'))
    )
    expect(verdict.findings).toEqual([])
    expect(verdict.unreadable).toEqual([])
    expect(verdict.cleared).toBe(true)
    expect(rowOf(verdict).status).toBe('not-applicable')
  })

  it('stands down on an _init that initialises something other than the registry', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(
        scheduleBatch([
          diamondCut(FACET, toFunctionSelector('initSomething()'), [
            {
              facetAddress: FACET,
              action: 0,
              functionSelectors: [REGISTER_SELECTOR],
            },
          ]),
        ])
      ),
      chain(new Error('must not be read'))
    )
    expect(verdict.findings).toEqual([])
    expect(verdict.unreadable).toEqual([])
    expect(verdict.cleared).toBe(true)
  })

  it('refuses a registration nested in _init past the unwrap bound', async () => {
    let data = register('TokenWrapper')
    for (let depth = 0; depth < 6; depth++) data = diamondCut(DIAMOND, data)
    const verdict = await evaluatePeripheryAllowlist(
      direct(data),
      chain([DEPOSIT, WITHDRAW])
    )
    expect(verdict.findings).toEqual([])
    expect(verdict.unreadable).toHaveLength(1)
    expect(verdict.unreadable[0]).toContain('nested too deep')
    expect(verdict.cleared).toBe(false)
  })

  it('refuses a cut that does not decode but carries the registration selector', async () => {
    const whole = diamondCut(FACET, register('TokenWrapper'))
    const verdict = await evaluatePeripheryAllowlist(
      direct(whole.slice(0, whole.length - 64) as Hex),
      chain([DEPOSIT, WITHDRAW])
    )
    expect(verdict.unreadable).toHaveLength(1)
    expect(verdict.cleared).toBe(false)
  })
})

describe('gate W remedy', () => {
  it.each(['tron', 'tronshasta'])(
    'on %s names the whitelist sync, since the paired proposer refuses Tron',
    async (network) => {
      const verdict = await evaluatePeripheryAllowlist(
        direct(register('TokenWrapper'), network),
        chain([])
      )
      const lines = renderPeripheryAllowlistLines(verdict).join('\n')
      expect(lines).toContain(
        `./script/tasks/syncWhitelistToNetworks.sh ${network} --production`
      )
      expect(lines).not.toContain('proposePeripheryWithWhitelist.ts')
      const row = rowOf(verdict, network)
      expect(row.detail).toContain('syncWhitelistToNetworks.sh')
      expect(row.detail).not.toContain('proposePeripheryWithWhitelist.ts')
    }
  )

  it('on tron reaches the rendered check ledger for the diamond the deploy log names', async () => {
    const tronDeployments = JSON.parse(
      readFileSync(path.join(HERE, '../../../deployments/tron.json'), 'utf8')
    ) as Record<string, string>
    const diamond = normalizeAddressForNetwork(
      'tron',
      tronDeployments.LiFiDiamond as string
    )
    const wrapper = normalizeAddressForNetwork(
      'tron',
      tronDeployments.TokenWrapper as string
    )
    const deps = chain([])
    const verdict = await evaluatePeripheryAllowlist(
      {
        calldatas: [register('TokenWrapper', wrapper)],
        targets: [diamond],
        caller: SAFE,
        network: 'tron',
      },
      deps
    )
    expect(verdict.cleared).toBe(false)
    expect(deps.reads).toEqual([`${diamond}:${wrapper}`])

    const ledger = createCheckLedger({
      expectedNetworks: ['tron'],
      checks: [PERIPHERY_ALLOWLIST_CHECK],
    })
    recordCheck(ledger, peripheryAllowlistCheckResult(verdict, 'tron'))
    const rendered = renderCheckLedger(ledger)
      .join(' ')
      .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
      .replace(/\s+/g, ' ')
    expect(rendered).toContain(
      './script/tasks/syncWhitelistToNetworks.sh tron --production'
    )
    expect(rendered).not.toContain('proposePeripheryWithWhitelist.ts')
  })

  it('on an EVM network names the paired proposer', async () => {
    expect(peripheryAllowlistRemedy('gnosis')).toContain(
      'proposePeripheryWithWhitelist.ts'
    )
    expect(peripheryAllowlistRemedy('gnosis')).toContain('--networks gnosis')
    const verdict = await evaluatePeripheryAllowlist(
      direct(register('TokenWrapper')),
      chain([])
    )
    expect(rowOf(verdict).detail).toContain('proposePeripheryWithWhitelist.ts')
  })
})

describe('gate W printing of proposer-controlled text', () => {
  const INVISIBLE = 'Token\u3164Wrapper'
  const CONTROL = 'Executor\u001b[2J'

  it('discloses an invisible character in a registered name', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      direct(register(INVISIBLE)),
      chain([])
    )
    expect(verdict.findings[0]?.status).toBe('not-diamond-called')
    const lines = renderPeripheryAllowlistLines(verdict).join('\n')
    expect(lines).toContain('1 invisible character')
    const row = rowOf(verdict)
    expect(row.actual).toContain('1 invisible character')
    expect(row.actual).not.toContain('\u001b')
  })

  it('strips a control sequence from a registered name and says so', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      direct(register(CONTROL)),
      chain([])
    )
    const lines = renderPeripheryAllowlistLines(verdict).join('\n')
    expect(lines).toContain('Executor[2J')
    expect(lines).toContain('sanitised for display')
    expect(lines).not.toContain('\u001b[2J')
    const row = rowOf(verdict)
    expect(row.actual).toContain('sanitised for display')
    expect(row.actual).not.toContain('\u001b')
  })

  it('sanitises a missing registration name in both expected and actual on the row', async () => {
    const graded = await evaluatePeripheryAllowlist(
      direct(register('TokenWrapper')),
      chain([])
    )
    const [finding] = graded.findings
    if (!finding) throw new Error('no finding')
    expect(finding.status).toBe('missing')
    const verdict: IPeripheryAllowlistVerdict = {
      ...graded,
      findings: [{ ...finding, name: 'Token\u001b[2JㅤWrapper' }],
    }
    const row = rowOf(verdict)
    for (const field of [row.expected, row.actual]) {
      expect(field).toStartWith(
        'Token[2JㅤWrapper (⚠ sanitised for display — stored 17, printable 16; 1 invisible character among 16 printable): '
      )
      expect(field).not.toContain('\u001b')
    }
    expect(row.expected).toContain(`allowlisted for ${TOKEN_WRAPPER}`)
    expect(row.actual).toContain('missing, observed none')
  })

  it('adds no notice to a clean name', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      direct(register('Executor')),
      chain([])
    )
    const lines = renderPeripheryAllowlistLines(verdict).join('\n')
    expect(lines).toContain('Executor')
    expect(lines).not.toContain('sanitised for display')
    expect(lines).not.toContain('invisible character')
  })

  it('sanitises the reason an evaluation threw', () => {
    const verdict = blockedPeripheryAllowlist('gnosis', 'bad\u001b[2Jconfig')
    const lines = renderPeripheryAllowlistLines(verdict).join('\n')
    expect(lines).toContain('bad[2Jconfig')
    expect(lines).toContain('sanitised for display')
    expect(lines).not.toContain('\u001b')
  })

  it('sanitises a read failure reason in the lines and on the row', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      direct(register('TokenWrapper')),
      chain(new Error('boom\u001b[31m'))
    )
    const lines = renderPeripheryAllowlistLines(verdict).join('\n')
    expect(lines).toContain('boom[31m')
    expect(lines).toContain('sanitised for display')
    expect(lines).not.toContain('boom\u001b[31m')
    const row = rowOf(verdict)
    expect(row.actual).toContain('boom[31m')
    expect(row.actual).not.toContain('\u001b')
  })
})

describe('gate W — remaining paths', () => {
  it('builds the client once, and only when a read is made', async () => {
    let built = 0
    const read = readAllowlistThrough(() => {
      built++
      return {
        readContract: (async () => [DEPOSIT]) as never,
      }
    })
    expect(built).toBe(0)
    expect(await read(DIAMOND, TOKEN_WRAPPER)).toEqual([DEPOSIT])
    await read(DIAMOND, TOKEN_WRAPPER)
    expect(built).toBe(1)
  })

  it('refuses a registration beside an unopened call carrying a whitelist selector', async () => {
    const hidden = encodeFunctionData({
      abi: ABI,
      functionName: 'mysteryEnvelope',
      args: [singleWhitelist(TOKEN_WRAPPER, DEPOSIT, false)],
    })
    const verdict = await evaluatePeripheryAllowlist(
      viaTimelock(scheduleBatch([register('TokenWrapper'), hidden])),
      chain([DEPOSIT, WITHDRAW])
    )
    expect(verdict.unreadable).toHaveLength(1)
    expect(verdict.unreadable[0]).toContain('whitelist selector')
    expect(verdict.cleared).toBe(false)
  })

  it('prints a deregistration as one line', async () => {
    const verdict = await evaluatePeripheryAllowlist(
      direct(register('TokenWrapper', ZERO)),
      chain([])
    )
    expect(renderPeripheryAllowlistLines(verdict).join('\n')).toContain(
      'bound to the zero address'
    )
  })
})
