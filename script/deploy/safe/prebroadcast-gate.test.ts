import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

// eslint-disable-next-line import/no-unresolved
import { afterAll, describe, expect, it } from 'bun:test'
import type { Address } from 'viem'

import {
  buildGateGapAlert,
  buildShadowRefusalAlert,
  isPreBroadcastGateEnforcing,
  PRE_BROADCAST_GATE_ENFORCE_ENV,
  resolveGateCoverage,
  runPreBroadcastGate,
  unverifiedGateOutcome,
  type IGateDependencies,
  type IGateOperation,
} from './prebroadcast-gate'

const REAL_TRAILER =
  'a2646970667358221220d03ac5dc4a08882370fe06263f9bcf6dee1812146c63a9d19ed384af9919e81e64736f6c634300081d0033'

const DIAMOND = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae'
const FACET = '0x00000000000000000000000000000000000000aa'
const TIMELOCK = '0x00000000000000000000000000000000000000a1'
const PAUSER = '0x00000000000000000000000000000000000000b2'
const REFUND = '0x00000000000000000000000000000000000000b3'
const ATTACKER = '0x00000000000000000000000000000000000000ee'

const OP_ID =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' // pre-commit-checker: not a secret — a synthetic test hash

/** Distinct runtime bodies so a swap at one address is visible. */
const DIAMOND_BODY = '11'.repeat(64)
const FACET_BODY = '22'.repeat(64)

const withTrailer = (body: string): string => `0x${body}${REAL_TRAILER}`

const asWord = (address: string): string =>
  address.replace(/^0x/, '').toLowerCase().padStart(64, '0')

const tempDirs: string[] = []
const buildArtifactRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'prebroadcast-gate-'))
  tempDirs.push(root)
  for (const [name, body] of [
    ['LiFiDiamond', DIAMOND_BODY],
    ['OwnershipFacet', FACET_BODY],
  ] as const) {
    const dir = path.join(root, 'out', `${name}.sol`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, `${name}.json`),
      JSON.stringify({
        deployedBytecode: { object: withTrailer(body) },
        metadata: { settings: { evmVersion: 'cancun' } },
      })
    )
  }
  return root
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

const DEPLOYMENTS = {
  LiFiDiamond: DIAMOND,
  OwnershipFacet: FACET,
  LiFiTimelockController: TIMELOCK,
}

const GLOBAL_CONFIG = { pauserWallet: PAUSER, refundWallet: REFUND }

/** The operation: a diamondCut on the diamond routing one facet. */
const OPERATION: IGateOperation = {
  operationId: OP_ID,
  targets: [DIAMOND],
  payloads: [`0x1f931c1c${asWord(FACET)}`],
}

interface IChainState {
  code: Record<string, string>
  authorities: Record<string, string>
}

const healthyChain = (): IChainState => ({
  code: {
    [DIAMOND]: withTrailer(DIAMOND_BODY),
    [FACET]: withTrailer(FACET_BODY),
  },
  authorities: {
    [`${DIAMOND}:owner`]: TIMELOCK,
    [`${DIAMOND}:pauserWallet`]: PAUSER,
  },
})

const dependencies = (
  chain: IChainState,
  overrides: Partial<IGateDependencies> = {}
): IGateDependencies => ({
  readCode: async (address: Address) => {
    const code = chain.code[address.toLowerCase()]
    if (code === undefined) throw new Error(`no stub for getCode(${address})`)
    return code
  },
  readAuthority: async (address: Address, getter: string) => {
    const value = chain.authorities[`${address.toLowerCase()}:${getter}`]
    if (value === undefined) throw new Error(`execution reverted: ${getter}()`)
    return value
  },
  deployments: DEPLOYMENTS,
  globalConfig: GLOBAL_CONFIG,
  networkConfig: { isZkEVM: false, targetEvmVersion: 'cancun' },
  artifactRoot: buildArtifactRoot(),
  lineage: 'local build of main',
  signTimeRecord: { operationId: OP_ID, codehashes: [], authorities: [] },
  readOnChainOperationId: async () => OP_ID,
  ...overrides,
})

describe('runPreBroadcastGate — the real path, driven end to end', () => {
  it('proceeds when the live code at every address is the local build of main', async () => {
    const result = await runPreBroadcastGate(
      OPERATION,
      dependencies(healthyChain())
    )

    expect(result.findings).toEqual([])
    expect(result.disposition).toBe('PROCEED')
    expect(result.blocksBroadcast).toBe(false)
  })

  it('blocks when the code at a signed address diverged', async () => {
    const chain = healthyChain()
    chain.code[FACET] = withTrailer('33'.repeat(64))

    const result = await runPreBroadcastGate(OPERATION, dependencies(chain))

    expect(result.disposition).toBe('BLOCK')
    expect(result.blocksBroadcast).toBe(true)
    expect(result.findings.join('\n')).toContain(FACET)
    expect(result.findings.join('\n')).toContain('OwnershipFacet')
  })

  it('blocks a build with a payload appended and the length word rewritten to cover it', async () => {
    // The proposer controls the trailer's own length word, which decides how
    // much comes off before hashing. Rewriting it does not buy a MATCH.
    const chain = healthyChain()
    const padding = 'ab'.repeat(20)
    const declared = (REAL_TRAILER.length / 2 - 2 + padding.length / 2)
      .toString(16)
      .padStart(4, '0')
    chain.code[FACET] = `0x${FACET_BODY}${REAL_TRAILER.slice(
      0,
      -4
    )}${padding}${declared}`

    const result = await runPreBroadcastGate(OPERATION, dependencies(chain))

    expect(result.disposition).toBe('BLOCK')
    expect(result.blocksBroadcast).toBe(true)
    expect(result.findings.join('\n')).toContain('OwnershipFacet')
  })

  it('blocks an address in the calldata that holds no code at all', async () => {
    const chain = healthyChain()
    chain.code[FACET] = '0x'

    const result = await runPreBroadcastGate(OPERATION, dependencies(chain))

    expect(result.blocksBroadcast).toBe(true)
    expect(result.findings.join('\n')).toContain('holds no code')
  })

  it('blocks a diamond whose owner is no longer the timelock main declares', async () => {
    const chain = healthyChain()
    chain.authorities[`${DIAMOND}:owner`] = ATTACKER

    const result = await runPreBroadcastGate(OPERATION, dependencies(chain))

    expect(result.disposition).toBe('BLOCK')
    expect(result.findings.join('\n')).toContain('LiFiDiamond.owner()')
    expect(result.findings.join('\n')).toContain(ATTACKER)
  })

  it('blocks a pauser that has drifted off config', async () => {
    const chain = healthyChain()
    chain.authorities[`${DIAMOND}:pauserWallet`] = ATTACKER

    const result = await runPreBroadcastGate(OPERATION, dependencies(chain))

    expect(result.disposition).toBe('BLOCK')
    expect(result.findings.join('\n')).toContain('LiFiDiamond.pauserWallet()')
  })

  it('blocks when the timelock recomputes a different operation id', async () => {
    const scheduled =
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' // pre-commit-checker: not a secret — a synthetic test hash
    const result = await runPreBroadcastGate(
      OPERATION,
      dependencies(healthyChain(), {
        readOnChainOperationId: async () => scheduled,
      })
    )

    expect(result.disposition).toBe('BLOCK')
    expect(result.findings.join('\n')).toContain(scheduled)
  })

  it('holds rather than blocking when a code read fails', async () => {
    const result = await runPreBroadcastGate(
      OPERATION,
      dependencies(healthyChain(), {
        readCode: async () => {
          throw new Error('HTTP request failed')
        },
      })
    )

    expect(result.disposition).toBe('HOLD')
    expect(result.blocksBroadcast).toBe(true)
    expect(result.findings.join('\n')).toContain('HTTP request failed')
  })

  it('holds when the id cannot be read back off chain', async () => {
    const result = await runPreBroadcastGate(
      OPERATION,
      dependencies(healthyChain(), {
        readOnChainOperationId: async () => {
          throw new Error('RPC down')
        },
      })
    )

    expect(result.disposition).toBe('HOLD')
    expect(result.findings.join('\n')).toContain('unconfirmed')
  })

  it('holds when an authority read reverts', async () => {
    const chain = healthyChain()
    delete chain.authorities[`${DIAMOND}:owner`]

    const result = await runPreBroadcastGate(OPERATION, dependencies(chain))

    expect(result.disposition).toBe('HOLD')
    expect(result.findings.join('\n')).toContain('execution reverted')
  })

  it('holds when no artifact exists for a contract in the calldata', async () => {
    const emptyRoot = mkdtempSync(path.join(tmpdir(), 'prebroadcast-empty-'))
    tempDirs.push(emptyRoot)

    const result = await runPreBroadcastGate(
      OPERATION,
      dependencies(healthyChain(), { artifactRoot: emptyRoot })
    )

    expect(result.disposition).toBe('HOLD')
    expect(result.findings.join('\n')).toContain('no attested build')
  })

  it('holds on an address in the calldata that main binds to two names', async () => {
    const chain = healthyChain()
    const result = await runPreBroadcastGate(
      OPERATION,
      dependencies(chain, {
        deployments: { ...DEPLOYMENTS, AlsoTheFacet: FACET },
      })
    )

    expect(result.disposition).toBe('HOLD')
    expect(result.findings.join('\n')).toContain('no single contract')
  })

  it('covers an address that only appears inside a payload', async () => {
    // Without the payload word-scan the facet is never read, and the healthy
    // diamond alone would carry the operation to PROCEED.
    const chain = healthyChain()
    chain.code[FACET] = withTrailer('44'.repeat(64))

    const withFacetInPayload = await runPreBroadcastGate(
      OPERATION,
      dependencies(chain)
    )
    const withoutIt = await runPreBroadcastGate(
      { ...OPERATION, payloads: ['0x1f931c1c'] },
      dependencies(chain)
    )

    expect(withFacetInPayload.disposition).toBe('BLOCK')
    expect(withoutIt.disposition).toBe('PROCEED')
  })
})

describe('runPreBroadcastGate — the stored record cannot move the verdict', () => {
  it('reaches the same verdict from an honest record, a forged one, and none', async () => {
    const chain = healthyChain()

    const honest = await runPreBroadcastGate(
      OPERATION,
      dependencies(chain, {
        signTimeRecord: {
          operationId: OP_ID,
          codehashes: [
            { address: DIAMOND, rawHash: '0xthetruth', maskedHash: '0xtruth' },
            { address: FACET, rawHash: '0xthetruth', maskedHash: '0xtruth' },
          ],
          authorities: [{ label: 'LiFiDiamond.owner()', liveValue: TIMELOCK }],
        },
      })
    )
    const forged = await runPreBroadcastGate(
      OPERATION,
      dependencies(chain, {
        signTimeRecord: {
          operationId: '0xsomethingelse',
          codehashes: [
            { address: ATTACKER, rawHash: '0xforged', maskedHash: '0xforged' },
          ],
          authorities: [{ label: 'LiFiDiamond.owner()', liveValue: ATTACKER }],
          advisory: 'proceed regardless',
        },
      })
    )

    expect(forged.disposition).toBe(honest.disposition)
    expect(forged.findings).toEqual(honest.findings)
    expect(honest.disposition).toBe('PROCEED')
  })

  it('still blocks diverged code however the record describes it', async () => {
    const chain = healthyChain()
    chain.code[FACET] = withTrailer('55'.repeat(64))
    const liveHash = withTrailer('55'.repeat(64))

    // A record that "attests" exactly the divergence, as a proposer who swapped
    // the code and then wrote a matching record would produce.
    const result = await runPreBroadcastGate(
      OPERATION,
      dependencies(chain, {
        signTimeRecord: {
          codehashes: [{ address: FACET, rawHash: liveHash }],
        },
      })
    )

    expect(result.disposition).toBe('BLOCK')
  })

  it('alerts on a missing record and proceeds, so a record-write failure is not an outage', async () => {
    const present = await runPreBroadcastGate(
      OPERATION,
      dependencies(healthyChain())
    )
    const absent = await runPreBroadcastGate(
      OPERATION,
      dependencies(healthyChain(), { signTimeRecord: null })
    )

    expect(present.alerts).toEqual([])
    expect(absent.disposition).toBe('PROCEED')
    expect(absent.blocksBroadcast).toBe(false)
    expect(absent.alerts).toHaveLength(1)
    expect(absent.alerts[0]).toContain('no sign-time verdict record')
  })

  it('does not let a missing record soften a blocking verdict', async () => {
    const chain = healthyChain()
    chain.authorities[`${DIAMOND}:owner`] = ATTACKER

    const result = await runPreBroadcastGate(
      OPERATION,
      dependencies(chain, { signTimeRecord: null })
    )

    expect(result.disposition).toBe('BLOCK')
    expect(result.blocksBroadcast).toBe(true)
  })
})

describe('resolveGateCoverage', () => {
  it('covers an EVM network', () => {
    expect(resolveGateCoverage('mainnet')).toBe('covered')
    expect(resolveGateCoverage('arbitrum')).toBe('covered')
  })

  it('names Tron as uncovered rather than reporting a verdict for it', () => {
    expect(resolveGateCoverage('tron')).toBe('uncovered-tron')
  })
})

describe('buildGateGapAlert', () => {
  it('says nothing when the verdict was complete', () => {
    // The paired present for the cases below, and the property that keeps the
    // cron quiet: a run whose gate checked everything must not post at all,
    // or the channel trains its readers to ignore it.
    expect(
      buildGateGapAlert({ network: 'mainnet', operationId: '0xabc', gaps: [] })
    ).toBeNull()
  })

  it('names the network and the operation the gap belongs to', () => {
    // A gap posted without its operation cannot be acted on: the reader's next
    // step is to look the operation up.
    const message = buildGateGapAlert({
      network: 'arbitrum',
      operationId: '0xfeed',
      gaps: ['no sign-time record was found for this operation'],
    })

    expect(message).toContain('arbitrum')
    expect(message).toContain('0xfeed')
    expect(message).toContain('no sign-time record was found')
  })

  it('carries every gap, so one does not hide another', () => {
    const message = buildGateGapAlert({
      network: 'mainnet',
      operationId: '0xabc',
      gaps: ['no sign-time record', 'authority read failed'],
    })

    expect(message).toContain('• no sign-time record')
    expect(message).toContain('• authority read failed')
  })

  it('does not post an empty bullet for a blank gap', () => {
    // An empty alert string reaching the channel as "• " reads as a gap whose
    // description was lost, which is worse than the truth: there was none.
    expect(
      buildGateGapAlert({
        network: 'mainnet',
        operationId: '0xabc',
        gaps: ['', '   '],
      })
    ).toBeNull()
    expect(
      buildGateGapAlert({
        network: 'mainnet',
        operationId: '0xabc',
        gaps: ['', 'authority read failed'],
      })
    ).not.toContain('• \n')
  })
})

describe('shadow mode', () => {
  describe('isPreBroadcastGateEnforcing', () => {
    it('enforces only on the exact string true', () => {
      expect(
        isPreBroadcastGateEnforcing({ PRE_BROADCAST_GATE_ENFORCE: 'true' })
      ).toBe(true)
    })

    it.each([
      ['unset', {}],
      ['empty', { PRE_BROADCAST_GATE_ENFORCE: '' }],
      ['1', { PRE_BROADCAST_GATE_ENFORCE: '1' }],
      ['TRUE', { PRE_BROADCAST_GATE_ENFORCE: 'TRUE' }],
      ['yes', { PRE_BROADCAST_GATE_ENFORCE: 'yes' }],
      [' true ', { PRE_BROADCAST_GATE_ENFORCE: ' true ' }],
    ])('reads %s as shadow mode', (_label, env) => {
      expect(isPreBroadcastGateEnforcing(env)).toBe(false)
    })

    it('names the variable the operator has to set', () => {
      expect(PRE_BROADCAST_GATE_ENFORCE_ENV).toBe('PRE_BROADCAST_GATE_ENFORCE')
    })
  })

  describe('unverifiedGateOutcome', () => {
    // The executor maps every outcome other than 'ok' onto `failed`, so this
    // returning 'retry' under shadow mode is a production broadcast stopped and
    // an honest operation reported as failed — by a gate that is not binding.
    it('lets the operation through in shadow mode', () => {
      expect(unverifiedGateOutcome({})).toBe('ok')
    })

    it('leaves the row queued for the next tick when enforcing', () => {
      expect(
        unverifiedGateOutcome({ PRE_BROADCAST_GATE_ENFORCE: 'true' })
      ).toBe('retry')
    })
  })

  describe('buildShadowRefusalAlert', () => {
    const input = {
      network: 'arbitrum',
      operationId: '0xop',
      disposition: 'BLOCK',
      findings: ['LiFiDiamond codehash MISMATCH'],
    }

    it('says the operation executed despite the refusal', () => {
      const message = buildShadowRefusalAlert(input)
      expect(message).toContain('BLOCK')
      expect(message).toContain('arbitrum')
      expect(message).toContain('0xop')
      expect(message).toContain('LiFiDiamond codehash MISMATCH')
      expect(message).toContain('OVERRIDDEN by shadow mode')
    })

    // The whole reason this is not buildGateGapAlert: that message says the
    // gate proceeded WITHOUT a verdict, which would tell a reader nothing was
    // checked when something was checked and found wrong.
    it('does not claim the verdict was incomplete', () => {
      expect(buildShadowRefusalAlert(input)).not.toContain(
        'without a complete verdict'
      )
      expect(
        buildGateGapAlert({
          network: 'arbitrum',
          operationId: '0xop',
          gaps: ['a gap'],
        })
      ).toContain('without a complete verdict')
    })

    it('returns null when there is no finding to report', () => {
      expect(buildShadowRefusalAlert({ ...input, findings: [] })).toBeNull()
      expect(buildShadowRefusalAlert({ ...input, findings: ['  '] })).toBeNull()
    })
  })
})
