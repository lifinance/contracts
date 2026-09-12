// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  createCheckLedger,
  recordCheck,
  summariseLedger,
  type ICheckResult,
} from './check-ledger'
import {
  CHECK_SAFE_ADDRESS,
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

describe('viewDefinitions', () => {
  it('names the signature check by its subject, not by a count', () => {
    expect(viewDefinitions().get(CHECK_SIGNATURES)?.title).toBe(
      'Signatures recover to current owners'
    )
  })

  it('names the executability check "Calldata simulation"', () => {
    const definitions = viewDefinitions([
      {
        checkId: 'executability',
        section: 'Execution',
        checkClass: 'semantic',
        title: 'The proposal would execute rather than revert',
      },
    ])

    expect(definitions.get('executability')?.title).toBe('Calldata simulation')
  })

  it('leaves a title this view does not override alone', () => {
    const own = INTEGRITY_CHECK_DEFINITIONS[CHECK_SAFE_ADDRESS]?.title ?? ''

    expect(own).not.toBe('')
    expect(viewDefinitions().get(CHECK_SAFE_ADDRESS)?.title).toBe(own)
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
  it('puts the out-of-band comparison before the device panel', () => {
    const todos = signerTodos({
      deviceHash: `0x${'ab'.repeat(32)}`,
      storedHash: 'agrees',
      devicePanel: ['screen 1'],
    })

    expect(todos).toHaveLength(2)
    expect(todos[0]?.text).toContain('out-of-band')
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
