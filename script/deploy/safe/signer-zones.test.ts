// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  createCheckLedger,
  recordCheck,
  summariseLedger,
  type ICheckDefinition,
  type ICheckResult,
} from './check-ledger'
import {
  CHECK_SAFE_ADDRESS,
  CHECK_SAFE_TX_HASH,
  CHECK_SIGNATURES,
  CHECK_TIMELOCK_DELAY,
  INTEGRITY_CHECK_DEFINITIONS,
  type IIntegrityAssertRun,
} from './confirm-integrity-asserts'
import { bucketOf, renderCheckGroups } from './signer-view'
import {
  integrityResults,
  signerChecks,
  signerTodos,
  viewDefinitions,
} from './signer-zones'

const ESC = String.fromCharCode(27)
const stripAnsi = (s: string): string =>
  s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')

const NETWORK = 'arbitrum'

const runWith = (
  registered: readonly string[],
  results: readonly Omit<ICheckResult, 'network'>[]
): IIntegrityAssertRun => {
  const ledger = createCheckLedger({
    expectedNetworks: [NETWORK],
    checks: registered.map((checkId) => {
      const definition = INTEGRITY_CHECK_DEFINITIONS[checkId]
      if (!definition) throw new Error(`no definition for ${checkId}`)
      return definition
    }),
  })
  for (const result of results)
    recordCheck(ledger, { ...result, network: NETWORK })
  return {
    ledger,
    verdict: summariseLedger(ledger),
    registered: [...registered],
    gradedKey: 'graded-key',
  }
}

/** One failing row for `checkId`, rendered the way a signer sees it. */
const renderFailing = (
  checkId: string,
  extra: readonly ICheckDefinition[] = []
): string =>
  renderCheckGroups(
    signerChecks({
      results: [
        {
          checkId,
          network: NETWORK,
          status: 'fail',
          expected: 'the declared value',
          actual: 'something else',
          anchor: 'A-CHAIN',
        },
      ],
      definitions: viewDefinitions(extra),
    })
  )
    .map(stripAnsi)
    .join('\n')

describe('gate naming', () => {
  it('heads a row with the gate letter and its subject', () => {
    expect(renderFailing(CHECK_SIGNATURES)).toContain(
      'Gate C \u00b7 Owner signatures'
    )
  })

  it("uses an extra definition's own letter", () => {
    expect(
      renderFailing('executability', [
        {
          checkId: 'executability',
          section: 'Execution',
          checkClass: 'semantic',
          gate: 'I',
          title: 'Calldata simulation',
        },
      ])
    ).toContain('Gate I \u00b7 Calldata simulation')
  })

  it('never states the assertion in the row a red glyph heads', () => {
    const rendered = renderFailing(CHECK_SAFE_TX_HASH)

    expect(rendered).toContain('Gate B \u00b7 Safe tx hash')
    expect(rendered).not.toContain('equals the stored one')
  })

  it('gives every definition a unique single-letter gate', () => {
    const definitions = [...viewDefinitions().values()]

    expect(definitions.length).toBeGreaterThan(1)
    for (const definition of definitions)
      expect(definition.gate).toMatch(/^[A-Z]$/u)

    const letters = definitions.map((definition) => definition.gate)
    expect(new Set(letters).size).toBe(letters.length)
  })
})

describe('integrityResults', () => {
  it('reports a run that never happened as unverified, never as a pass', () => {
    const { results } = integrityResults(undefined)

    expect(results).toHaveLength(1)
    expect(bucketOf(results[0]?.status ?? '')).toBe('unchecked')
  })

  it('calls a check that was registered and answered nothing unverified', () => {
    const { results } = integrityResults(runWith([CHECK_SAFE_ADDRESS], []))

    expect(results[0]?.status).toBe('error')
  })

  it('reports an unregistered delay check as not applicable, not as a status', () => {
    const { results, notApplicable } = integrityResults(
      runWith(
        [CHECK_SAFE_ADDRESS],
        [
          {
            checkId: CHECK_SAFE_ADDRESS,
            status: 'pass',
            expected: 'the configured Safe',
            actual: 'the configured Safe',
            anchor: 'A-LOCAL',
          },
        ]
      )
    )

    expect(results.map((result) => result.checkId)).toEqual([
      CHECK_SAFE_ADDRESS,
    ])
    expect(notApplicable.get(CHECK_TIMELOCK_DELAY)).toContain(
      'not a timelock schedule'
    )
  })
})

describe('signerChecks', () => {
  it('groups a not-applicable check under its reason rather than a verdict', () => {
    const rows = signerChecks({
      results: [],
      notApplicable: new Map([
        [CHECK_TIMELOCK_DELAY, 'this proposal is not a timelock schedule'],
      ]),
      definitions: viewDefinitions(),
    })
    const rendered = renderCheckGroups(rows).map(stripAnsi).join('\n')

    expect(rendered).toContain('NOT APPLICABLE')
    expect(rendered).toContain('not a timelock schedule')
    expect(rendered).not.toContain('PASSED')
  })

  it('never puts a check that answered in the not-applicable bucket too', () => {
    const rows = signerChecks({
      results: [
        {
          checkId: CHECK_TIMELOCK_DELAY,
          network: NETWORK,
          status: 'pass',
          expected: 'nothing to compare',
          actual: 'this proposal schedules nothing',
          anchor: 'A-LOCAL',
        },
      ],
      notApplicable: new Map([
        [CHECK_TIMELOCK_DELAY, 'this proposal is not a timelock schedule'],
      ]),
      definitions: viewDefinitions(),
    })

    expect(rows).toHaveLength(1)
    expect(renderCheckGroups(rows).map(stripAnsi).join('\n')).not.toContain(
      'NOT APPLICABLE'
    )
  })

  it('carries a definition-less result through under its check id', () => {
    const rows = signerChecks({
      results: [
        {
          checkId: 'invented',
          network: NETWORK,
          status: 'fail',
          expected: 'something',
          actual: 'something else',
          anchor: 'A-CHAIN',
        },
      ],
      definitions: viewDefinitions(),
    })

    expect(renderCheckGroups(rows).map(stripAnsi).join('\n')).toContain(
      'invented'
    )
  })
})

describe('signerTodos', () => {
  it('puts the message comparison before the device panel', () => {
    const todos = signerTodos({
      deviceHash: `0x${'ab'.repeat(32)}`,
      storedHash: 'agrees',
      devicePanel: ['screen 1'],
    })

    expect(todos).toHaveLength(2)
    expect(todos[0]?.text).toContain('the proposer sent you')
    expect(todos[1]?.text).toContain('device')
  })

  it('says the hash could not be computed rather than showing none', () => {
    const [todo] = signerTodos({})

    expect(stripAnsi((todo?.lines ?? []).join('\n'))).toContain(
      'could not be computed'
    )
  })

  it('warns when the stored hash disagrees with the computed one', () => {
    const [todo] = signerTodos({
      deviceHash: `0x${'cd'.repeat(32)}`,
      storedHash: 'disagrees',
    })

    expect(stripAnsi((todo?.lines ?? []).join('\n'))).toContain(
      'is not the hash the Safe computes'
    )
  })

  it('omits the device step when no panel could be drawn', () => {
    expect(signerTodos({ deviceHash: `0x${'ef'.repeat(32)}` })).toHaveLength(1)
  })
})

describe('a device note carrying its own line breaks', () => {
  it('indents every line of it, not just the first', () => {
    const [, device] = signerTodos({
      deviceHash: `0x${'ab'.repeat(32)}`,
      devicePanel: ['screen'],
      devicePanelNote: 'first caveat\nsecond caveat',
    })

    expect(device?.lines).toEqual(['screen', 'first caveat', 'second caveat'])
  })
})

describe('the Safe-address check', () => {
  it('is named as a gate, not as a claim about the proposal', () => {
    expect(renderFailing(CHECK_SAFE_ADDRESS)).toContain(
      'Gate A \u00b7 Safe address'
    )
  })
})
