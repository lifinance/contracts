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
  parseAbi,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem'

import globalConfig from '../../../config/global.json'

import { gateLabel } from './check-ledger'
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
  peripheryFunctionsFromConfig,
  renderPeripheryAllowlistLines,
  renderPeripheryAllowlistRefusal,
  type IPeripheryAllowlistDeps,
  type IPeripheryAllowlistVerdict,
} from './periphery-allowlist-gate'
import {
  TIMELOCK_SCHEDULE_ABI,
  TIMELOCK_SCHEDULE_BATCH_ABI,
} from './timelock-abi'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' as Address
const OTHER_DIAMOND = '0xF3B20515d9B193531c48E47c18aF16d1e5d28f9a' as Address
const TIMELOCK = '0x5604A94A3438C3074EFFF803fab14B7244fe4E29' as Address
// gnosis op 38's TokenWrapper, whose allowlist was empty when it was signed
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

/** A reader that answers from a fixed table and counts what it was asked. */
const chain = (
  allowlisted: readonly Hex[] | Error = []
): IPeripheryAllowlistDeps & { reads: string[] } => {
  const reads: string[] = []
  return {
    reads,
    peripheryFunctions: PERIPHERY_FUNCTIONS,
    readWhitelistedSelectors: async (diamond, contract) => {
      reads.push(`${diamond}:${contract}`)
      if (allowlisted instanceof Error) throw allowlisted
      return allowlisted
    },
  }
}

const viaTimelock = (data: Hex) => ({
  calldatas: [data],
  targets: [TIMELOCK],
  caller: SAFE,
})
const direct = (data: Hex) => ({
  calldatas: [data],
  targets: [DIAMOND],
  caller: SAFE,
})

const rowOf = (verdict: IPeripheryAllowlistVerdict) =>
  peripheryAllowlistCheckResult(verdict, 'gnosis')

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
      { calldatas: [register('TokenWrapper')], targets: [], caller: SAFE },
      chain([DEPOSIT, WITHDRAW])
    )
    expect(verdict.cleared).toBe(false)
    expect(verdict.findings[0]?.status).toBe('read-failed')
  })

  it('a verdict for an evaluation that threw blocks', () => {
    const verdict = blockedPeripheryAllowlist('config unreadable')
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
