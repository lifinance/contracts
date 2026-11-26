// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'
import { keccak256, type Address, type Hex } from 'viem'

import {
  buildGateGapAlert,
  buildShadowRefusalAlert,
  createPinnedDeploymentsReader,
  isPreBroadcastGateEnforcing,
  observeCalldata,
  PRE_BROADCAST_GATE_ENFORCE_ENV,
  runPreBroadcastGate,
  unverifiedGateOutcome,
  type IGateDependencies,
  type IGateOperation,
} from './prebroadcast-gate'
import {
  createPinnedBlobReader,
  type IPinnedStateGit,
} from './pinned-target-state'

const DIAMOND = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae'
const FACET = '0x00000000000000000000000000000000000000aa'
const TIMELOCK = '0x00000000000000000000000000000000000000a1'
const PAUSER = '0x00000000000000000000000000000000000000b2'
const REFUND = '0x00000000000000000000000000000000000000b3'
const ATTACKER = '0x00000000000000000000000000000000000000ee'

const OP_ID =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' // pre-commit-checker: not a secret — a synthetic test hash

/** Distinct runtime bodies so a swap at one address is visible. */
const DIAMOND_BODY = `0x${'11'.repeat(64)}`
const FACET_BODY = `0x${'22'.repeat(64)}`

const asWord = (address: string): string =>
  address.replace(/^0x/, '').toLowerCase().padStart(64, '0')

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
  code: { [DIAMOND]: DIAMOND_BODY, [FACET]: FACET_BODY },
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
  pinnedDeployments: DEPLOYMENTS,
  globalConfig: GLOBAL_CONFIG,
  signTimeRecord: { operationId: OP_ID, codehashes: [], authorities: [] },
  readScheduledAt: async () => 1_700_000_000n,
  ...overrides,
})

describe('runPreBroadcastGate — the real path, driven end to end', () => {
  it('proceeds when the timelock holds the operation and every authority matches', async () => {
    const result = await runPreBroadcastGate(
      OPERATION,
      dependencies(healthyChain())
    )
    expect(result.disposition).toBe('PROCEED')
    expect(result.blocksBroadcast).toBe(false)
  })

  it('blocks a diamond whose owner is no longer the timelock main declares', async () => {
    const chain = healthyChain()
    chain.authorities[`${DIAMOND}:owner`] = ATTACKER
    const result = await runPreBroadcastGate(OPERATION, dependencies(chain))
    expect(result.disposition).toBe('BLOCK')
    expect(result.findings.join(' ')).toContain(ATTACKER)
  })

  it('blocks a pauser that has drifted off config', async () => {
    const chain = healthyChain()
    chain.authorities[`${DIAMOND}:pauserWallet`] = ATTACKER
    const result = await runPreBroadcastGate(OPERATION, dependencies(chain))
    expect(result.disposition).toBe('BLOCK')
    expect(result.findings.join(' ')).toContain('pauserWallet')
  })

  it('blocks when the timelock has nothing scheduled under the id', async () => {
    const result = await runPreBroadcastGate(
      OPERATION,
      dependencies(healthyChain(), { readScheduledAt: async () => 0n })
    )
    expect(result.disposition).toBe('BLOCK')
    expect(result.findings.join(' ')).toContain('no schedule entry')
  })

  it('holds when the timelock cannot be asked what it scheduled', async () => {
    const result = await runPreBroadcastGate(
      OPERATION,
      dependencies(healthyChain(), {
        readScheduledAt: async () => {
          throw new Error('node unreachable')
        },
      })
    )
    expect(result.disposition).toBe('HOLD')
    expect(result.findings.join(' ')).toContain('could not be asked')
  })

  it('holds when an authority read reverts', async () => {
    const chain = healthyChain()
    delete chain.authorities[`${DIAMOND}:owner`]
    const result = await runPreBroadcastGate(OPERATION, dependencies(chain))
    expect(result.disposition).toBe('HOLD')
    expect(result.findings.join(' ')).toContain('execution reverted')
  })

  it('reads authorities on an address that only appears inside a payload', async () => {
    // The diamond is reached through the payload rather than as a target, so a
    // gate that only walked `targets` would read no authority for it at all.
    const operation: IGateOperation = {
      operationId: OP_ID,
      targets: [FACET],
      payloads: [`0x1f931c1c${asWord(DIAMOND)}`],
    }
    const chain = healthyChain()
    chain.authorities[`${DIAMOND}:owner`] = ATTACKER
    const result = await runPreBroadcastGate(operation, dependencies(chain))
    expect(result.disposition).toBe('BLOCK')
    expect(result.findings.join(' ')).toContain(ATTACKER)
  })
})

describe('observeCalldata — what the sign-time record is built from', () => {
  it('hashes exactly the bytes it read, with nothing local folded in', async () => {
    const { targets } = await observeCalldata(
      OPERATION,
      dependencies(healthyChain())
    )
    const diamond = targets.find((target) => target.address === DIAMOND)
    expect(diamond?.rawHash).toBe(keccak256(DIAMOND_BODY as Hex))
    expect(diamond?.rawByteLength).toBe(64)
    expect(diamond?.observationError).toBeUndefined()
  })

  it('gives two signers reading the same chain identical observations', async () => {
    // The record's whole value: three machines' copies are comparable only if
    // the hash depends on the chain and on nothing either machine holds.
    const first = await observeCalldata(OPERATION, dependencies(healthyChain()))
    const second = await observeCalldata(
      OPERATION,
      dependencies(healthyChain())
    )
    expect(first.targets).toEqual(second.targets)
    // And an actual code change moves it, so the equality above is not vacuous.
    const changed = healthyChain()
    changed.code[DIAMOND] = `0x${'33'.repeat(64)}`
    const third = await observeCalldata(OPERATION, dependencies(changed))
    expect(third.targets).not.toEqual(first.targets)
  })

  it('records why an address could not be read rather than dropping it', async () => {
    const chain = healthyChain()
    delete chain.code[FACET]
    const { targets } = await observeCalldata(OPERATION, dependencies(chain))
    const facet = targets.find((target) => target.address === FACET)
    expect(facet).toBeDefined()
    expect(facet?.rawHash).toBeUndefined()
    expect(facet?.observationError).toContain('no stub for getCode')
  })

  it('refuses code that is not an even-length hex string', async () => {
    const chain = healthyChain()
    chain.code[FACET] = '0xabc'
    const { targets } = await observeCalldata(OPERATION, dependencies(chain))
    const facet = targets.find((target) => target.address === FACET)
    expect(facet?.rawHash).toBeUndefined()
    expect(facet?.observationError).toContain('even-length hex')
  })

  it('carries where each authority expectation came from', async () => {
    const { authorities } = await observeCalldata(
      OPERATION,
      dependencies(healthyChain())
    )
    const owner = authorities.find((row) => row.label.includes('owner'))
    const pauser = authorities.find((row) => row.label.includes('pauser'))
    // owner is declared against the deployment record as `origin/main` has it,
    // pauserWallet against config/global.json — the ledger anchors the row on
    // that difference.
    expect(owner?.expectationSource).toBe('pinnedDeployments')
    expect(pauser?.expectationSource).toBe('globalConfig')
  })

  it('does not accept a timelock the branch declares and main does not', async () => {
    const { authorities } = await observeCalldata(OPERATION, {
      ...dependencies(healthyChain()),
      pinnedDeployments: {},
    })
    const owner = authorities.find((row) => row.label.includes('owner'))

    // The branch's own deploy log still carries the address, so an expectation
    // that read it would resolve and the row would match. It must not: the
    // whole point of the pinned source is that a proposer cannot author the
    // value their proposal is judged against.
    expect(owner?.liveValue).toBeDefined()
    expect(owner?.expectedValue).toBeUndefined()
  })
})

describe('runPreBroadcastGate — the stored record cannot move the verdict', () => {
  it('reaches the same verdict from an honest record, a forged one, and none', async () => {
    const verdicts = await Promise.all(
      [
        { operationId: OP_ID, authorities: [] },
        {
          operationId: OP_ID,
          disposition: 'PROCEED',
          authorities: [{ label: 'LiFiDiamond.owner()', liveValue: ATTACKER }],
        },
        null,
      ].map(async (signTimeRecord) => {
        const chain = healthyChain()
        chain.authorities[`${DIAMOND}:owner`] = ATTACKER
        const result = await runPreBroadcastGate(
          OPERATION,
          dependencies(chain, { signTimeRecord })
        )
        return { disposition: result.disposition, findings: result.findings }
      })
    )
    const [honest, forged, absent] = verdicts
    if (!honest || !forged || !absent)
      throw new Error('every record variant must produce a verdict')
    expect(forged).toEqual(honest)
    expect(absent).toEqual(honest)
    // Not vacuous: the verdict they all reach is the refusal.
    expect(honest.disposition).toBe('BLOCK')
  })

  it('alerts on a missing record and proceeds, so a record-write failure is not an outage', async () => {
    const result = await runPreBroadcastGate(
      OPERATION,
      dependencies(healthyChain(), { signTimeRecord: null })
    )
    expect(result.disposition).toBe('PROCEED')
    expect(result.alerts.join(' ')).toContain('audit trail has a gap')
  })

  it('does not let a missing record soften a blocking verdict', async () => {
    const chain = healthyChain()
    chain.authorities[`${DIAMOND}:owner`] = ATTACKER
    const result = await runPreBroadcastGate(
      OPERATION,
      dependencies(chain, { signTimeRecord: null })
    )
    expect(result.disposition).toBe('BLOCK')
  })
})

describe('runPreBroadcastGate — the owner expectation at execute time', () => {
  const NETWORK = 'arbitrum'
  const PINNED_PATH = `deployments/${NETWORK}.json`

  /** A clone whose `origin/main` holds exactly these blobs. */
  const pinnedGit = (
    blobs: Record<string, string>,
    counts = { fetch: 0 },
    fetchFails = false
  ): IPinnedStateGit => ({
    remoteUrl: async () => 'git@github.com:lifinance/contracts.git',
    fetch: async () => {
      counts.fetch += 1
      if (fetchFails) throw new Error('remote timed out')
    },
    revParse: async () => 'abc1234\n',
    show: async (revSpec) => {
      const blob = blobs[revSpec.split(':')[1] ?? '']
      if (blob === undefined) throw new Error('no such path')
      return blob
    },
  })

  const pinnedReader = (
    git: IPinnedStateGit
  ): ReturnType<typeof createPinnedDeploymentsReader> =>
    createPinnedDeploymentsReader(
      createPinnedBlobReader({ repoRoot: '/repo', git })
    )

  /**
   * Runs the gate with its dependencies wired as the executor wires them: the
   * branch's own deploy log as `deployments`, and the pinned read spread in
   * only when it succeeded.
   */
  const gateAtExecuteTime = async (
    chain: IChainState,
    local: Record<string, unknown>,
    git: IPinnedStateGit
  ): ReturnType<typeof runPreBroadcastGate> => {
    const pinned = await pinnedReader(git)(NETWORK)
    const { pinnedDeployments: _default, ...rest } = dependencies(chain, {
      deployments: local,
    })
    return runPreBroadcastGate(OPERATION, {
      ...rest,
      ...(pinned.ok ? { pinnedDeployments: pinned.value } : {}),
    })
  }

  const ownerFindings = (findings: readonly string[]): string[] =>
    findings.filter((finding) => finding.startsWith('LiFiDiamond.owner()'))

  // The branch's log names whatever the live owner is, so any case below that
  // reads it instead of main would pass or block for the wrong reason.
  const branchDeclaring = (timelock: string): Record<string, unknown> => ({
    ...DEPLOYMENTS,
    LiFiTimelockController: timelock,
  })

  const mainHolding = (deployments: Record<string, unknown>): IPinnedStateGit =>
    pinnedGit({ [PINNED_PATH]: JSON.stringify(deployments) })

  it('finds nothing on the owner when it is the timelock main declares', async () => {
    const result = await gateAtExecuteTime(
      healthyChain(),
      branchDeclaring(ATTACKER),
      mainHolding(DEPLOYMENTS)
    )
    expect(ownerFindings(result.findings)).toEqual([])
    expect(result.disposition).toBe('PROCEED')
  })

  it('blocks an owner that is not the timelock main declares, whatever the branch says', async () => {
    const chain = healthyChain()
    chain.authorities[`${DIAMOND}:owner`] = ATTACKER
    const result = await gateAtExecuteTime(
      chain,
      branchDeclaring(ATTACKER),
      mainHolding(DEPLOYMENTS)
    )
    expect(result.disposition).toBe('BLOCK')
    expect(ownerFindings(result.findings)).toEqual([
      `LiFiDiamond.owner(): holds ${ATTACKER} on chain where main declares ${TIMELOCK}`,
    ])
  })

  const unjudgedOwner = `LiFiDiamond.owner(): main declares no expected value, so the live ${TIMELOCK} cannot be judged`

  it('holds when the fetch of main fails, rather than judging against the branch', async () => {
    const result = await gateAtExecuteTime(
      healthyChain(),
      branchDeclaring(TIMELOCK),
      pinnedGit({ [PINNED_PATH]: JSON.stringify(DEPLOYMENTS) }, undefined, true)
    )
    expect(result.disposition).toBe('HOLD')
    expect(ownerFindings(result.findings)).toEqual([unjudgedOwner])
  })

  it('holds when main has no file for the network, rather than judging against the branch', async () => {
    const result = await gateAtExecuteTime(
      healthyChain(),
      branchDeclaring(TIMELOCK),
      pinnedGit({})
    )
    expect(result.disposition).toBe('HOLD')
    expect(ownerFindings(result.findings)).toEqual([unjudgedOwner])
  })

  it('tries an unreachable remote once per run, not once per operation', async () => {
    const counts = { fetch: 0 }
    const read = pinnedReader(pinnedGit({}, counts, true))

    const reads = await Promise.all(['arbitrum', 'base', 'optimism'].map(read))
    await read('arbitrum')

    for (const each of reads)
      expect(each).toEqual({ ok: false, reason: 'fetch-failed' })
    expect(counts.fetch).toBe(1)
  })

  it('asks again after an origin that could not be read', async () => {
    let remoteReads = 0
    const git: IPinnedStateGit = {
      ...mainHolding(DEPLOYMENTS),
      remoteUrl: async () => {
        remoteReads += 1
        if (remoteReads === 1) throw new Error('git exited 128')
        return 'git@github.com:lifinance/contracts.git'
      },
    }
    const read = pinnedReader(git)

    expect(await read(NETWORK)).toEqual({
      ok: false,
      reason: 'remote-unreadable',
    })
    expect(await read(NETWORK)).toEqual({ ok: true, value: DEPLOYMENTS })
  })

  it('keeps reading other networks when one network has no file on main', async () => {
    const read = pinnedReader(
      pinnedGit({ 'deployments/base.json': JSON.stringify(DEPLOYMENTS) })
    )

    expect(await read('arbitrum')).toEqual({
      ok: false,
      reason: 'blob-unreadable',
    })
    expect(await read('base')).toEqual({ ok: true, value: DEPLOYMENTS })
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
      findings: ['LiFiDiamond.owner() holds 0xee…, main declares 0xa1…'],
    }

    it('says the operation executed despite the refusal', () => {
      const message = buildShadowRefusalAlert(input)
      expect(message).toContain('BLOCK')
      expect(message).toContain('arbitrum')
      expect(message).toContain('0xop')
      expect(message).toContain('LiFiDiamond.owner()')
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

// Every string an observation carries is persisted to MongoDB and, under
// enforcement, posted to Slack — outside the job log's `::add-mask::`
// protection. viem puts the full node URL in the message it throws, so an
// unredacted read error publishes the provider's API key.
describe('observation errors never carry the endpoint that produced them', () => {
  const KEYED_URL = 'https://lb.drpc.org/ogrpc?network=arbitrum&dkey=s3cr3tkey'
  const viemFailure = (): Error =>
    new Error(
      `HTTP request failed.\n\nStatus: 429\nURL: ${KEYED_URL}\n\nDetails: rate limited`
    )

  it('redacts the URL out of an unreadable target', async () => {
    const chain = healthyChain()
    const { targets } = await observeCalldata(
      OPERATION,
      dependencies(chain, {
        readCode: async () => {
          throw viemFailure()
        },
      })
    )
    const reported = targets.map((target) => target.observationError ?? '')
    expect(reported.join(' ')).not.toContain('dkey')
    expect(reported.join(' ')).not.toContain('drpc.org')
    // Positive control: the row still reports, so the absence above is
    // redaction rather than an observation that never happened.
    expect(reported.join(' ')).toContain('[redacted-url]')
    expect(reported.join(' ')).toContain('Status: 429')
  })

  it('redacts the URL out of an unreadable authority', async () => {
    const { authorities } = await observeCalldata(
      OPERATION,
      dependencies(healthyChain(), {
        readAuthority: async () => {
          throw viemFailure()
        },
      })
    )
    const reported = authorities.map((row) => row.readError ?? '')
    expect(reported.join(' ')).not.toContain('dkey')
    expect(reported.join(' ')).not.toContain('drpc.org')
    expect(reported.join(' ')).toContain('[redacted-url]')
  })

  // The gate's own findings are what `buildShadowRefusalAlert` publishes, so
  // the seam has to hold all the way through the verdict, not only in the row.
  it('keeps the endpoint out of the verdict a refusal alert is built from', async () => {
    const result = await runPreBroadcastGate(
      OPERATION,
      dependencies(healthyChain(), {
        readAuthority: async () => {
          throw viemFailure()
        },
      })
    )
    const published = [
      result.reason,
      ...result.findings,
      ...result.alerts,
      buildShadowRefusalAlert({
        network: 'arbitrum',
        operationId: OP_ID,
        disposition: result.disposition,
        findings: result.findings,
      }) ?? '',
    ].join(' ')
    expect(published).not.toContain('dkey')
    expect(published).not.toContain('drpc.org')
    // Positive control: the read error does reach the published text, so the
    // two absences above are redaction and not an empty verdict.
    expect(published).toContain('[redacted-url]')
    expect(result.disposition).toBe('HOLD')
  })
})
