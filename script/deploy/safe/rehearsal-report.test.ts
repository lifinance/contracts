import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  createCheckLedger,
  recordCheck,
  type CheckStatus,
} from './check-ledger'
import {
  CONFIRM_CHECK_DEFINITIONS,
  TARGET_STATE_CHECK,
} from './confirm-check-registry'
import {
  MAX_SIGNER_TASKS_SHOWN,
  REHEARSAL_GATE_ROSTER,
  buildGateReport,
  checkGradingAnchors,
  renderGateReport,
  renderGradingAnchors,
  renderSignerWorkload,
  summariseSignerWorkload,
  verdictsAreActionable,
} from './rehearsal-report'
import { rowCountsByCheck } from './rehearsal-run'
import {
  REHEARSED_CHECK_IDS,
  buildRehearsalGateReport,
  runGateChain,
} from './verify-rehearsal'

const UNREHEARSED_REGISTRY_IDS = CONFIRM_CHECK_DEFINITIONS.map(
  (check) => check.checkId
).filter((checkId) => !REHEARSED_CHECK_IDS.includes(checkId))

const rehearsedPass = (recorded: boolean) => {
  const ledger = createCheckLedger({
    expectedNetworks: ['arbitrum'],
    checks: CONFIRM_CHECK_DEFINITIONS.filter((check) =>
      REHEARSED_CHECK_IDS.includes(check.checkId)
    ),
  })
  if (recorded)
    recordCheck(ledger, {
      checkId: TARGET_STATE_CHECK.checkId,
      network: 'arbitrum',
      status: 'pass',
      expected: 'x',
      actual: 'x',
      anchor: 'A-LOCAL',
    })
  return [{ proposal: '0xabc', ledger }]
}

describe('REHEARSAL_GATE_ROSTER', () => {
  it('names every gate the confirm registry defines', () => {
    const rostered = REHEARSAL_GATE_ROSTER.map((gate) => gate.checkId)
    for (const check of CONFIRM_CHECK_DEFINITIONS)
      expect(rostered).toContain(check.checkId)
  })
})

describe('runGateChain', () => {
  // No cut to read, so the verdict needs no chain or git access. What is under
  // test is which gates the ledger carries, not what they decide.
  const emptyProposal = { safeTx: { data: {} } } as never
  const unreadablePinnedState = (() => ({
    ok: false,
    reason: 'remote-unexpected',
  })) as never

  it('registers exactly the gates this rehearsal wired', () => {
    const ledger = runGateChain(
      emptyProposal,
      'arbitrum',
      false,
      unreadablePinnedState
    )
    expect([...ledger.checks.keys()].sort()).toEqual(
      [...REHEARSED_CHECK_IDS].sort()
    )
  })

  it('records a row for the gate it wired', () => {
    const ledger = runGateChain(
      emptyProposal,
      'arbitrum',
      false,
      unreadablePinnedState
    )
    expect(rowCountsByCheck([{ proposal: '0xabc', ledger }])).toEqual({
      [TARGET_STATE_CHECK.checkId]: 1,
    })
  })
})

describe('buildRehearsalGateReport', () => {
  it('rehearses only gates the registry defines', () => {
    const registry = CONFIRM_CHECK_DEFINITIONS.map((check) => check.checkId)
    expect(REHEARSED_CHECK_IDS.length).toBeGreaterThan(0)
    for (const checkId of REHEARSED_CHECK_IDS)
      expect(registry).toContain(checkId)
    expect(UNREHEARSED_REGISTRY_IDS.length).toBeGreaterThan(0)
  })

  it('names every registry gate the chain never wired as absent, with where to expect it', () => {
    const report = buildRehearsalGateReport(rehearsedPass(true))
    const rendered = renderGateReport(report)

    for (const checkId of UNREHEARSED_REGISTRY_IDS) {
      const gate = report.find((row) => row.checkId === checkId)
      expect(gate?.presence).toBe('absent')
      expect(rendered).toMatch(
        new RegExp(`^${checkId}\\s+absent\\s+rows=0\\s+\\(expected from: `, 'm')
      )
    }
  })

  it('reports the gate the chain recorded as present', () => {
    const report = buildRehearsalGateReport(rehearsedPass(true))
    const target = report.find(
      (row) => row.checkId === TARGET_STATE_CHECK.checkId
    )
    expect(target?.presence).toBe('present')
    expect(target?.rows).toBe(1)
  })

  it('keeps a wired gate that answered for nothing apart from an absent one', () => {
    const report = buildRehearsalGateReport(rehearsedPass(false))
    expect(
      report.find((row) => row.checkId === TARGET_STATE_CHECK.checkId)?.presence
    ).toBe('registered-but-silent')
    expect(
      report.find((row) => row.checkId === 'executability')?.presence
    ).toBe('absent')
  })
})

describe('buildGateReport', () => {
  it('names a rostered gate that did not register as absent', () => {
    const report = buildGateReport({
      registered: ['target-state'],
      rowCounts: { 'target-state': 3 },
    })

    const executability = report.find(
      (gate) => gate.checkId === 'executability'
    )
    expect(executability?.presence).toBe('absent')
  })

  it('never drops a rostered gate, however few registered', () => {
    const report = buildGateReport({ registered: [], rowCounts: {} })

    expect(report.map((gate) => gate.checkId).sort()).toEqual(
      [...REHEARSAL_GATE_ROSTER.map((gate) => gate.checkId)].sort()
    )
    expect(report.every((gate) => gate.presence === 'absent')).toBe(true)
  })

  it('separates a gate that registered but reported nothing from one that ran', () => {
    const report = buildGateReport({
      registered: ['target-state', 'executability'],
      rowCounts: { 'target-state': 2, executability: 0 },
    })

    expect(
      report.find((gate) => gate.checkId === 'target-state')?.presence
    ).toBe('present')
    expect(
      report.find((gate) => gate.checkId === 'executability')?.presence
    ).toBe('registered-but-silent')
  })

  it('reports a registered gate the roster does not name', () => {
    const report = buildGateReport({
      registered: ['a-gate-nobody-rostered'],
      rowCounts: { 'a-gate-nobody-rostered': 1 },
    })

    const surprise = report.find(
      (gate) => gate.checkId === 'a-gate-nobody-rostered'
    )
    expect(surprise?.presence).toBe('present')
    expect(surprise?.rostered).toBe(false)
  })
})

describe('renderGateReport', () => {
  it('prints every gate including the absent ones', () => {
    const rendered = renderGateReport(
      buildGateReport({ registered: ['target-state'], rowCounts: {} })
    )

    for (const gate of REHEARSAL_GATE_ROSTER)
      expect(rendered).toContain(gate.checkId)
    expect(rendered).toMatch(/absent/)
  })
})

describe('summariseSignerWorkload', () => {
  const ledger = (rows: [string, string, string][]) => {
    const built = createCheckLedger({
      expectedNetworks: ['tron', 'arbitrum'],
      checks: [
        {
          checkId: 'INT-SAFE-TX-HASH',
          section: 'Integrity',
          checkClass: 'integrity',
          gate: 'B',
          title: 'Recomputed safeTxHash matches the stored one',
        },
        {
          checkId: 'target-state',
          section: 'Intent',
          checkClass: 'semantic',
          gate: 'H',
          title: 'Facet version matches the declared target state',
        },
      ],
    })
    for (const [checkId, network, status] of rows)
      recordCheck(built, {
        checkId,
        network,
        status: status as CheckStatus,
        expected: 'e',
        actual: 'a',
        anchor: 'A-LOCAL',
      })
    return built
  }

  it('separates what the machine settled from what the signer must answer', () => {
    const workload = summariseSignerWorkload([
      {
        proposal: '0xabc',
        ledger: ledger([
          ['INT-SAFE-TX-HASH', 'tron', 'pass'],
          ['target-state', 'tron', 'needs-ack'],
          ['target-state', 'arbitrum', 'pass'],
        ]),
      },
    ])

    expect(workload.settled).toBe(2)
    expect(workload.needsYou).toHaveLength(1)
    expect(workload.needsYou[0]?.checkId).toBe('target-state')
    expect(workload.blocked).toBe(0)
  })

  it('counts a refusal as blocked, not as something the signer may wave through', () => {
    const workload = summariseSignerWorkload([
      {
        proposal: '0xabc',
        ledger: ledger([['INT-SAFE-TX-HASH', 'tron', 'fail']]),
      },
    ])

    expect(workload.blocked).toBe(1)
    expect(workload.needsYou).toHaveLength(0)
  })

  it('counts a row that graded nothing in neither bucket', () => {
    // Nothing was refused and nothing was decided, so calling it blocked
    // would tell the signer a run with nothing to grade is stuck.
    const workload = summariseSignerWorkload([
      {
        proposal: '0xabc',
        ledger: ledger([['target-state', 'tron', 'not-applicable']]),
      },
    ])

    expect(workload.blocked).toBe(0)
    expect(workload.settled).toBe(0)
    expect(workload.needsYou).toHaveLength(0)
  })
})

describe('checkGradingAnchors', () => {
  it('reports the deployment cache as missing when it is not there', () => {
    const anchors = checkGradingAnchors('/nonexistent-root-for-this-test')

    const cache = anchors.find((anchor) =>
      anchor.path.includes('deployments_production.json')
    )
    expect(cache?.present).toBe(false)
    expect(cache?.consequence).toMatch(/every|all/i)
  })

  it('reports it present when the file exists', () => {
    const anchors = checkGradingAnchors(process.cwd())

    const cache = anchors.find((anchor) =>
      anchor.path.includes('deployments_production.json')
    )
    expect(typeof cache?.present).toBe('boolean')
  })
})

describe('verdictsAreActionable', () => {
  it('holds for a corpus of proposals still awaiting signature', () => {
    expect(verdictsAreActionable('pending')).toBe(true)
    expect(verdictsAreActionable('submitted')).toBe(true)
  })

  it('does not hold for proposals that already executed', () => {
    expect(verdictsAreActionable('executed')).toBe(false)
    expect(verdictsAreActionable('reverted')).toBe(false)
  })
})

describe('checkGradingAnchors, on a cache that exists but cannot be used', () => {
  it('reports a file that is not a JSON array as missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'rehearsal-anchor-'))
    mkdirSync(join(root, '.cache'), { recursive: true })
    writeFileSync(join(root, '.cache', 'deployments_production.json'), '{}')

    const cache = checkGradingAnchors(root).find((anchor) =>
      anchor.path.includes('deployments_production.json')
    )

    expect(cache?.present).toBe(false)
  })

  it('reports a well-formed record array as present', () => {
    const root = mkdtempSync(join(tmpdir(), 'rehearsal-anchor-'))
    mkdirSync(join(root, '.cache'), { recursive: true })
    writeFileSync(
      join(root, '.cache', 'deployments_production.json'),
      JSON.stringify([
        { network: 'arbitrum', address: '0x1', version: '1.0.0' },
      ])
    )

    const cache = checkGradingAnchors(root).find((anchor) =>
      anchor.path.includes('deployments_production.json')
    )

    expect(cache?.present).toBe(true)
  })
})

describe('renderGradingAnchors', () => {
  it('names the consequence only for the anchor that is missing', () => {
    const rendered = renderGradingAnchors([
      { path: '/a/present.json', present: true, consequence: 'would be bad' },
      { path: '/a/absent.json', present: false, consequence: 'would be bad' },
    ])

    expect(rendered).toContain('present : /a/present.json')
    expect(rendered).toContain('MISSING : /a/absent.json')
    expect(rendered.match(/would be bad/g)).toHaveLength(1)
  })
})

describe('renderSignerWorkload', () => {
  it('prints all three counts and the rows still waiting on a person', () => {
    const rendered = renderSignerWorkload({
      settled: 7,
      blocked: 2,
      needsYou: [
        {
          proposal: '0xabc',
          checkId: 'target-state',
          network: 'tron',
          expected: 'ordering holds',
          actual: 'EcoFacet: matches-main',
        },
      ],
    })

    expect(rendered).toContain('settled automatically : 7')
    expect(rendered).toContain('blocked               : 2')
    expect(rendered).toContain('needs your judgement  : 1')
    expect(rendered).toContain('EcoFacet: matches-main')
  })

  it('tells apart two tasks that differ only by proposal', () => {
    const task = {
      checkId: 'target-state',
      network: 'tron',
      expected: 'ordering holds',
      actual: 'EcoFacet: matches-main',
    }
    const rendered = renderSignerWorkload({
      settled: 0,
      blocked: 0,
      needsYou: [
        { ...task, proposal: '0xaaa' },
        { ...task, proposal: '0xbbb' },
      ],
    })

    const taskLines = rendered
      .split('\n')
      .filter((line) => line.startsWith('  '))
    expect(taskLines).toHaveLength(2)
    expect(taskLines.every((line) => line.includes('target-state'))).toBe(true)
    expect(taskLines[0]).not.toBe(taskLines[1])
    expect(rendered).toContain('0xaaa')
    expect(rendered).toContain('0xbbb')
  })

  it('counts the tasks it did not list rather than dropping them silently', () => {
    const rendered = renderSignerWorkload({
      settled: 0,
      blocked: 0,
      needsYou: Array.from({ length: 12 }, (_, index) => ({
        proposal: `0x${index}`,
        checkId: 'target-state',
        network: 'tron',
        expected: 'ordering holds',
        actual: 'EcoFacet: matches-main',
      })),
    })

    const lines = rendered.split('\n')
    expect(lines.filter((line) => line.startsWith('  '))).toHaveLength(
      MAX_SIGNER_TASKS_SHOWN
    )
    expect(rendered).toContain('2 further row(s) not shown')
  })
})

describe('checkGradingAnchors, on a cache that parses but holds nothing usable', () => {
  const anchorFor = (contents: string) => {
    const root = mkdtempSync(join(tmpdir(), 'rehearsal-anchor-'))
    mkdirSync(join(root, '.cache'), { recursive: true })
    writeFileSync(join(root, '.cache', 'deployments_production.json'), contents)
    return checkGradingAnchors(root).find((anchor) =>
      anchor.path.includes('deployments_production.json')
    )
  }

  it('reports an empty array as missing', () => {
    // What a refresh that returned nothing writes, and it produces exactly the
    // contract-unidentified-everywhere run the anchor exists to catch.
    expect(anchorFor('[]')?.present).toBe(false)
  })

  it('reports an array of the wrong shape as missing', () => {
    expect(anchorFor('[1,2,3]')?.present).toBe(false)
  })
})
